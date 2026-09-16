import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseEnabled, context, pool, migrate, withBusiness, loadDatabaseStore, saveDatabaseStore, requireRole, httpError, members, rateLimit as databaseRateLimit } from './lib/database.mjs';
import { authenticate, authAction, checkOrigin } from './lib/auth.mjs';
import { enqueue, listJobs, cancelJob, startQueue, stopQueue } from './lib/jobs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const dataDir = path.join(here, "data");
const storePath = process.env.CAMPAIGN_STORE_PATH || path.join(dataDir, "store.json");
const port = Number(process.env.PORT || 3000);
const maxBodyBytes = 256_000;
const maxDailyBudget = Number(process.env.MAX_DAILY_BUDGET || 100);
const liveMode = process.env.ENABLE_LIVE_CONNECTORS === "true";
const aiRequests = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const ALLOWED_GOALS = ["sales", "leads", "retention", "awareness"];
const CAMPAIGN_STATUSES = ["draft", "planned", "approved", "prepared", "simulated", "live", "blocked"];
const DEFAULT_CONNECTORS = [
  { id: "meta", name: "Meta Ads", type: "paid-social" },
  { id: "google", name: "Google Ads", type: "paid-search" },
  { id: "linkedin", name: "LinkedIn Ads", type: "b2b-paid" },
  { id: "email", name: "Email provider", type: "owned" },
];

function now() {
  return new Date().toISOString();
}

function seedStore() {
  return {
    businesses: [{ id: "default-business", name: "Default workspace", industry: "", audience: "", geography: "", language: "English", tone: "Clear and factual", currency: "USD", channels: ["meta"], dailyBudget: 25 }],
    products: [{
      businessId: "default-business",
      id: "demo-offer",
      name: "Demo offer — replace before launch",
      kind: "service",
      price: 0,
      grossMargin: 0,
      capacity: "Set real inventory or delivery capacity",
      proof: "No claims approved yet",
      createdAt: now(),
    }],
    campaigns: [],
    feedback: [],
    connectors: DEFAULT_CONNECTORS.map((connector) => ({
      ...connector,
      apiBaseUrl: "",
      secretRef: `MARKETING_${connector.id.toUpperCase()}_TOKEN`,
      updatedAt: now(),
    })),
    activity: [{ id: randomUUID(), at: now(), type: "system", message: "Workspace created in simulation mode." }],
  };
}

async function loadStore() {
  if (databaseEnabled) return loadDatabaseStore(seedStore());
  if (!existsSync(storePath)) return seedStore();
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    const store = { ...seedStore(), ...parsed };
    for (const product of store.products) product.businessId ||= "default-business";
    for (const campaign of store.campaigns) campaign.businessId ||= store.products.find((product) => product.id === campaign.productId)?.businessId || "default-business";
    return store;
  } catch {
    throw new Error("Campaign store is unreadable. Restore data/store.json from a backup before writing.");
  }
}

async function saveStore(store) {
  if (databaseEnabled) return saveDatabaseStore(store);
  await mkdir(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, storePath);
}

function record(store, type, message, metadata = {}) {
  if (databaseEnabled) metadata.actorId = context.getStore()?.user.id;
  store.activity.unshift({ id: randomUUID(), at: now(), type, message, metadata });
  store.activity = store.activity.slice(0, 100);
}

function reply(res, status, payload) {
  if (databaseEnabled && context.getStore()) {
    context.getStore().response = { status, payload };
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
  });
  res.end(JSON.stringify(payload));
}

function fail(res, status, error, detail) {
  reply(res, status, { error, ...(detail ? { detail } : {}) });
}

function sanitizeText(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length < min || text.length > max) throw new Error(`${field} must be ${min}-${max} characters.`);
  return text;
}

function sanitizeArray(value, field, max = 4) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`${field} must have 1-${max} entries.`);
  return [...new Set(value.map((entry) => sanitizeText(entry, field, { min: 2, max: 60 })))];
}

function safeNumber(value, field, { min = 0, max = 1_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${field} must be between ${min} and ${max}.`);
  return Math.round(number * 100) / 100;
}

function secretReference(value) {
  const ref = sanitizeText(value, "Secret reference", { min: 3, max: 80 });
  if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) throw new Error("Secret reference must be an uppercase environment-variable name.");
  return ref;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function hasAdminAccess(req, { required = false } = {}) {
  const expected = process.env.APP_ADMIN_TOKEN;
  if (!expected) return !required;
  const supplied = req.headers["x-admin-token"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireOperator(req, res, { live = false } = {}) {
  if (databaseEnabled) {
    if (req.method === 'POST' && req.url === '/api/businesses') return true;
    requireRole('owner', 'editor');
    return true;
  }
  if (!hasAdminAccess(req, { required: live })) {
    fail(res, 401, "Operator authorization is required for this action.");
    return false;
  }
  return true;
}

function rateLimit(req) {
  const key = req.socket.remoteAddress || "unknown";
  const cutoff = Date.now() - 60_000;
  const attempts = (aiRequests.get(key) || []).filter((at) => at > cutoff);
  if (attempts.length >= 6) return false;
  attempts.push(Date.now());
  aiRequests.set(key, attempts);
  return true;
}

function publicConnector(connector) {
  return {
    id: connector.id,
    name: connector.name,
    type: connector.type,
    apiBaseUrl: connector.apiBaseUrl,
    secretRef: connector.secretRef,
    tokenConfigured: Boolean(process.env[connector.secretRef]),
    ready: Boolean(connector.apiBaseUrl && process.env[connector.secretRef]),
    updatedAt: connector.updatedAt,
  };
}

function findBusiness(store, id) {
  const business = store.businesses.find((entry) => entry.id === id);
  if (!business) throw new Error("Business not found.");
  return business;
}

function normalizeBusiness(input) {
  const currency = sanitizeText(input.currency || "USD", "Currency", { min: 3, max: 3 }).toUpperCase();
  if (!Intl.supportedValuesOf("currency").includes(currency)) throw new Error("Unsupported currency.");
  const channels = sanitizeArray(input.channels, "Channels");
  if (channels.some((id) => !DEFAULT_CONNECTORS.some((connector) => connector.id === id))) throw new Error("Unsupported channel.");
  return {
    name: sanitizeText(input.name, "Business name", { min: 2, max: 100 }),
    ...Object.fromEntries(["industry", "audience", "geography", "language", "tone"].map((field) => [field, sanitizeText(input[field] ?? "", field, { min: 0, max: 400 })])),
    currency, channels,
    dailyBudget: safeNumber(input.dailyBudget, "Daily budget", { min: 1, max: maxDailyBudget }),
    updatedAt: now(),
  };
}

function normalizeCampaign(input) {
  const goal = sanitizeText(input.goal, "Goal", { min: 3, max: 30 }).toLowerCase();
  if (!ALLOWED_GOALS.includes(goal)) throw new Error(`Goal must be one of: ${ALLOWED_GOALS.join(", ")}.`);
  return {
    id: randomUUID(),
    name: sanitizeText(input.name, "Campaign name", { min: 3, max: 100 }),
    productId: sanitizeText(input.productId, "Product", { min: 2, max: 80 }),
    goal,
    audience: sanitizeText(input.audience, "Audience", { min: 8, max: 400 }),
    offer: sanitizeText(input.offer, "Offer", { min: 3, max: 400 }),
    channels: sanitizeArray(input.channels, "Channels"),
    dailyBudget: safeNumber(input.dailyBudget, "Daily budget", { min: 1, max: maxDailyBudget }),
    status: "draft",
    createdAt: now(),
    updatedAt: now(),
    plan: null,
    execution: null,
    metrics: { spend: 0, leads: 0, conversions: 0, revenue: 0 },
  };
}

function fallbackPlan(campaign, product) {
  const headline = `${campaign.offer} for ${campaign.audience}`;
  return {
    positioning: `Lead with the specific outcome of ${product.name}; avoid claims not supported by the listed proof.`,
    primaryMessage: headline,
    creativeBrief: `Use a clear product/service image, one concrete benefit, proof where available, and one action-oriented CTA. Language: ${campaign.businessSnapshot?.language || "unspecified"}. Tone: ${campaign.businessSnapshot?.tone || "unspecified"}. Market: ${campaign.businessSnapshot?.geography || "unspecified"}.`,
    businessContext: campaign.businessSnapshot || null,
    landingPageBrief: `Show offer terms, price or qualification path, proof, delivery details, and a single ${campaign.goal} CTA.`,
    experiments: [
      { hypothesis: "A proof-led message will outperform a feature-led message.", variable: "Message angle", successMetric: campaign.goal === "sales" ? "conversion rate" : "qualified leads" },
      { hypothesis: "A narrower audience will improve lead quality.", variable: "Audience segment", successMetric: "cost per qualified action" },
    ],
    guardrails: ["Do not imply unavailable pricing, inventory, or outcomes.", "Stop or revise when qualified-action cost exceeds the approved threshold."],
    source: "deterministic fallback",
  };
}

function planPrompt(campaign, product) {
  return `Create a truthful marketing plan for this campaign. Return JSON only with positioning, primaryMessage, creativeBrief, landingPageBrief, experiments (array of {hypothesis, variable, successMetric}), and guardrails (array of strings). Do not invent testimonials, product facts, regulatory claims, prices, results, or guarantees.\n\nProduct: ${JSON.stringify(product)}\nCampaign: ${JSON.stringify(campaign)}`;
}

function executorPrompt(campaign, product) {
  return `Convert this already-approved campaign into a conservative generic REST connector payload. Return JSON only with name, objective, audience, offer, dailyBudget, channels, creatives (array of {headline, body, cta}), tracking (array of event names), and safetyNotes. Do not add targeting attributes, claims, budgets, or channels that are absent from the campaign.\n\nProduct: ${JSON.stringify(product)}\nCampaign: ${JSON.stringify(campaign)}`;
}

function parseModelJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  return JSON.parse(candidate);
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("The model returned no text output.");
}

async function askOpenAI({ model, instructions, input }) {
  if (!process.env.OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: 1_200,
      store: false,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
  }
  return extractOutputText(await response.json());
}

async function createPlan(campaign, product) {
  const text = await askOpenAI({
    model: process.env.OPENAI_GPT_MODEL || "gpt-5",
    instructions: "You are a commercial strategist. Produce useful, compliant, conversion-focused plans. Never fabricate evidence or commercial facts.",
    input: planPrompt(campaign, product),
  });
  if (!text) return fallbackPlan(campaign, product);
  const plan = parseModelJson(text);
  return { ...fallbackPlan(campaign, product), ...plan, source: "OpenAI GPT" };
}

function fallbackPayload(campaign) {
  return {
    businessId: campaign.businessId,
    currency: campaign.businessSnapshot?.currency || "USD",
    name: campaign.name,
    objective: campaign.goal,
    audience: campaign.audience,
    offer: campaign.offer,
    dailyBudget: campaign.dailyBudget,
    channels: campaign.channels,
    creatives: [{ headline: campaign.plan?.primaryMessage || campaign.offer, body: campaign.plan?.creativeBrief || campaign.offer, cta: campaign.goal === "sales" ? "Buy now" : "Learn more" }],
    tracking: [campaign.goal === "sales" ? "purchase" : "qualified_lead"],
    safetyNotes: ["Payload is constrained to the approved campaign brief.", "Provider-specific validation is still required before live use."],
  };
}

function validatePayload(payload, campaign) {
  if (!payload || typeof payload !== "object") throw new Error("Executor did not return an object payload.");
  const result = fallbackPayload(campaign);
  result.name = sanitizeText(payload.name || result.name, "Payload name", { min: 3, max: 100 });
  result.objective = campaign.goal;
  result.audience = campaign.audience;
  result.offer = campaign.offer;
  result.dailyBudget = campaign.dailyBudget;
  result.channels = campaign.channels;
  if (Array.isArray(payload.creatives) && payload.creatives.length) {
    result.creatives = payload.creatives.slice(0, 3).map((creative) => ({
      headline: sanitizeText(creative.headline, "Creative headline", { min: 3, max: 160 }),
      body: sanitizeText(creative.body, "Creative body", { min: 3, max: 1_000 }),
      cta: sanitizeText(creative.cta, "Creative CTA", { min: 2, max: 40 }),
    }));
  }
  result.tracking = Array.isArray(payload.tracking) ? payload.tracking.slice(0, 8).map((event) => sanitizeText(event, "Tracking event", { min: 2, max: 60 })) : result.tracking;
  result.safetyNotes = Array.isArray(payload.safetyNotes) ? payload.safetyNotes.slice(0, 8).map((note) => sanitizeText(note, "Safety note", { min: 3, max: 300 })) : result.safetyNotes;
  return result;
}

async function createExecutionPayload(campaign, product) {
  const text = await askOpenAI({
    model: process.env.OPENAI_CODEX_MODEL || "gpt-5.4",
    instructions: "You are a campaign operations executor. Translate only approved facts into a machine-readable payload. Do not authorize spend, access secrets, call tools, or change budgets.",
    input: executorPrompt(campaign, product),
  });
  if (!text) return { ...fallbackPayload(campaign), source: "deterministic executor fallback" };
  return { ...validatePayload(parseModelJson(text), campaign), source: "OpenAI executor" };
}

function dashboard(store) {
  const totals = store.campaigns.reduce((accumulator, campaign) => {
    for (const key of Object.keys(accumulator)) accumulator[key] += Number(campaign.metrics?.[key] || 0);
    return accumulator;
  }, { spend: 0, leads: 0, conversions: 0, revenue: 0 });
  const published = store.campaigns.filter((campaign) => ["simulated", "live"].includes(campaign.status));
  const feedbackThemes = {};
  for (const item of store.feedback) {
    for (const theme of item.themes || []) feedbackThemes[theme] = (feedbackThemes[theme] || 0) + 1;
  }
  return {
    totals: {
      ...totals,
      roas: totals.spend ? Math.round((totals.revenue / totals.spend) * 100) / 100 : null,
      costPerLead: totals.leads ? Math.round((totals.spend / totals.leads) * 100) / 100 : null,
      conversionRate: totals.leads ? Math.round((totals.conversions / totals.leads) * 10_000) / 100 : null,
    },
    campaigns: store.campaigns,
    products: store.products,
    businesses: store.businesses,
    selectedBusinessId: context.getStore()?.businessId || null,
    databaseMode: databaseEnabled,
    feedback: store.feedback,
    feedbackThemes: Object.entries(feedbackThemes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([theme, count]) => ({ theme, count })),
    connectors: store.connectors.map(publicConnector),
    activity: store.activity.slice(0, 12),
    safeguards: { liveMode, maxDailyBudget, adminTokenConfigured: Boolean(process.env.APP_ADMIN_TOKEN), openAIConfigured: Boolean(process.env.OPENAI_API_KEY) },
    publishedCount: published.length,
  };
}

function findCampaign(store, id) {
  const campaign = store.campaigns.find((entry) => entry.id === id);
  if (!campaign) throw new Error("Campaign not found.");
  return campaign;
}

function findProduct(store, id) {
  const product = store.products.find((entry) => entry.id === id);
  if (!product) throw new Error("Product not found. Create the product before creating a campaign.");
  return product;
}

async function publishToConnector(campaign, connector) {
  const token = process.env[connector.secretRef];
  if (!connector.apiBaseUrl || !token) throw new Error(`${connector.name} is not configured with an API base URL and token reference.`);
  const endpoint = new URL("campaigns", connector.apiBaseUrl.endsWith("/") ? connector.apiBaseUrl : `${connector.apiBaseUrl}/`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": campaign.id },
    body: JSON.stringify(campaign.execution.payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.text()).slice(0, 1_000);
  if (!response.ok) throw new Error(`${connector.name} rejected the campaign (${response.status}): ${body}`);
  return { connectorId: connector.id, status: response.status, response: body };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return fail(res, 403, "Forbidden");
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    });
    res.end(content);
  } catch {
    fail(res, 404, "Not found");
  }
}

let mutationQueue = Promise.resolve();

async function handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    let release;
    if (!databaseEnabled && ["POST", "PUT", "DELETE"].includes(req.method)) {
      const previous = mutationQueue;
      mutationQueue = new Promise((resolve) => { release = resolve; });
      await previous;
    }
    try {
      if (req.method === "GET" && pathname === "/api/health") return reply(res, 200, { ok: true, liveMode, store: existsSync(storePath) ? "ready" : "will initialize on first write" });
      if (req.method === "GET" && pathname === "/api/dashboard") return reply(res, 200, dashboard(await loadStore()));
      if (databaseEnabled && pathname === '/api/members') return reply(res, 200, { members: await members(req.method, await readJson(req)) });
      if (databaseEnabled && pathname === '/api/jobs' && req.method === 'GET') return reply(res, 200, { jobs: await listJobs() });
      if (databaseEnabled && /^\/api\/jobs\/[\w-]+\/cancel$/.test(pathname) && req.method === 'POST') return reply(res, 200, await cancelJob(pathname.split('/')[3]));

      if ((req.method === "POST" && pathname === "/api/businesses") ||
          (req.method === "PUT" && /^\/api\/businesses\/[\w-]+$/.test(pathname))) {
        if (!requireOperator(req, res)) return;
        const input = await readJson(req);
        const store = await loadStore();
        const settings = normalizeBusiness(input);
        const business = req.method === "PUT" ? findBusiness(store, pathname.split("/").at(-1)) : { id: randomUUID(), createdAt: now() };
        if (business.currency && business.currency !== settings.currency && store.products.some((product) => product.businessId === business.id)) throw new Error("Currency cannot change after offers exist. Create a separate business profile for another currency.");
        Object.assign(business, settings);
        if (req.method === "POST") store.businesses.push(business);
        record(store, "business", `Saved business: ${business.name}`, { businessId: business.id });
        await saveStore(store);
        return reply(res, req.method === "POST" ? 201 : 200, { business });
      }

      if (req.method === "POST" && pathname === "/api/products") {
        if (!requireOperator(req, res)) return;
        const input = await readJson(req);
        const store = await loadStore();
        const product = {
          businessId: findBusiness(store, input.businessId || context.getStore()?.businessId || "default-business").id,
          id: randomUUID(), name: sanitizeText(input.name, "Product name", { min: 3, max: 100 }),
          kind: sanitizeText(input.kind || "product", "Product type", { min: 3, max: 30 }),
          price: safeNumber(input.price, "Price", { min: 0, max: 1_000_000 }),
          grossMargin: safeNumber(input.grossMargin, "Gross margin", { min: 0, max: 100 }),
          capacity: sanitizeText(input.capacity, "Capacity", { min: 2, max: 200 }),
          proof: sanitizeText(input.proof, "Proof", { min: 2, max: 500 }), createdAt: now(),
        };
        store.products.push(product); record(store, "product", `Created product: ${product.name}`); await saveStore(store);
        return reply(res, 201, { product });
      }

      if (req.method === "POST" && pathname === "/api/campaigns") {
        if (!requireOperator(req, res)) return;
        const store = await loadStore();
        const input = await readJson(req);
        const product = findProduct(store, input.productId);
        const business = findBusiness(store, input.businessId || product.businessId);
        if (product.businessId !== business.id) throw new Error("Offer belongs to a different business.");
        const campaign = normalizeCampaign({ ...input, audience: input.audience || business.audience, channels: input.channels ?? business.channels, dailyBudget: input.dailyBudget ?? business.dailyBudget });
        if (campaign.channels.some((id) => !store.connectors.some((connector) => connector.id === id))) throw new Error("Unsupported channel.");
        campaign.businessId = business.id;
        campaign.businessSnapshot = structuredClone(business);
        store.campaigns.unshift(campaign); record(store, "campaign", `Created draft: ${campaign.name}`, { campaignId: campaign.id }); await saveStore(store);
        return reply(res, 201, { campaign });
      }

      const campaignAction = pathname.match(/^\/api\/campaigns\/([\w-]+)\/(plan|approve|prepare|run|metrics)$/);
      if (req.method === "POST" && campaignAction) {
        const [, campaignId, action] = campaignAction;
        if (!requireOperator(req, res, { live: action === "run" && liveMode })) return;
        if (action === 'plan' || action === 'prepare') {
          if (databaseEnabled) await databaseRateLimit('ai:' + context.getStore().user.id, 12);
          else if (!rateLimit(req)) return fail(res, 429, "AI request limit reached. Try again in one minute.");
        }
        const input = await readJson(req);
        const store = await loadStore();
        const campaign = findCampaign(store, campaignId);
        const product = findProduct(store, campaign.productId);
        if (databaseEnabled && ['approve', 'run'].includes(action)) requireRole('owner');
        if (databaseEnabled && ['plan', 'prepare', 'run'].includes(action)) {
          const job = await enqueue(campaign, action, input);
          return reply(res, 202, { job, campaign });
        }

        if (action === "plan") {
          if (!["draft", "planned"].includes(campaign.status)) throw new Error("Only draft or planned campaigns can be re-planned.");
          campaign.businessSnapshot = structuredClone(findBusiness(store, campaign.businessId));
          campaign.plan = await createPlan(campaign, product); campaign.status = "planned"; campaign.updatedAt = now();
          record(store, "ai-plan", `GPT planned: ${campaign.name}`, { campaignId }); await saveStore(store);
          return reply(res, 200, { campaign });
        }
        if (action === "approve") {
          if (campaign.status !== "planned") throw new Error("Only a planned campaign can be approved.");
          campaign.status = "approved"; campaign.approvedAt = now(); campaign.approvedBy = context.getStore()?.user.email || sanitizeText(input.approvedBy || "operator", "Approver", { min: 2, max: 80 }); campaign.updatedAt = now();
          record(store, "approval", `Approved: ${campaign.name}`, { campaignId, approvedBy: campaign.approvedBy }); await saveStore(store);
          return reply(res, 200, { campaign });
        }
        if (action === "prepare") {
          if (campaign.status !== "approved") throw new Error("Approve the campaign before preparing a connector payload.");
          campaign.execution = { payload: await createExecutionPayload(campaign, product), preparedAt: now(), results: [] }; campaign.status = "prepared"; campaign.updatedAt = now();
          record(store, "executor", `Executor prepared payload: ${campaign.name}`, { campaignId }); await saveStore(store);
          return reply(res, 200, { campaign });
        }
        if (action === "metrics") {
          if (!["simulated", "live"].includes(campaign.status)) throw new Error("Record results only after a simulated or live campaign run.");
          campaign.metrics = {
            spend: safeNumber(input.spend, "Spend", { min: 0, max: 10_000_000 }),
            leads: safeNumber(input.leads, "Leads", { min: 0, max: 10_000_000 }),
            conversions: safeNumber(input.conversions, "Conversions", { min: 0, max: 10_000_000 }),
            revenue: safeNumber(input.revenue, "Revenue", { min: 0, max: 100_000_000 }),
          };
          campaign.updatedAt = now();
          record(store, "results", `Recorded results: ${campaign.name}`, { campaignId, metrics: campaign.metrics }); await saveStore(store);
          return reply(res, 200, { campaign });
        }
        if (campaign.status !== "prepared") throw new Error("Prepare the connector payload before running a campaign.");
        if (input.confirmation !== "RUN") throw new Error("Type RUN to confirm a campaign execution.");
        if (campaign.dailyBudget > maxDailyBudget) throw new Error(`Campaign budget exceeds the configured cap of ${maxDailyBudget}.`);
        const connectors = store.connectors.filter((connector) => campaign.channels.includes(connector.id));
        if (!connectors.length) throw new Error("No configured connector matches this campaign's channels.");
        if (!liveMode) {
          campaign.execution.results = connectors.map((connector) => ({ connectorId: connector.id, mode: "simulation", payloadAccepted: true })); campaign.status = "simulated"; campaign.updatedAt = now();
          record(store, "simulation", `Simulated campaign run: ${campaign.name}`, { campaignId }); await saveStore(store);
          return reply(res, 200, { campaign, mode: "simulation" });
        }
        const results = [];
        for (const connector of connectors) results.push(await publishToConnector(campaign, connector));
        campaign.execution.results = results; campaign.status = "live"; campaign.launchedAt = now(); campaign.updatedAt = now();
        record(store, "live-run", `Published live campaign: ${campaign.name}`, { campaignId, connectorIds: connectors.map((connector) => connector.id) }); await saveStore(store);
        return reply(res, 200, { campaign, mode: "live" });
      }

      if (req.method === "PUT" && /^\/api\/connectors\/[\w-]+$/.test(pathname)) {
        if (!requireOperator(req, res)) return;
        if (databaseEnabled) requireRole('owner');
        const id = pathname.split("/").at(-1); const input = await readJson(req); const store = await loadStore();
        const connector = store.connectors.find((entry) => entry.id === id);
        if (!connector) throw new Error("Connector not found.");
        connector.apiBaseUrl = input.apiBaseUrl ? new URL(sanitizeText(input.apiBaseUrl, "API base URL", { min: 8, max: 300 })).toString() : "";
        connector.secretRef = secretReference(input.secretRef || connector.secretRef); connector.updatedAt = now();
        if (databaseEnabled && !connector.secretRef.startsWith(`MARKETING_${context.getStore().businessId.replaceAll('-', '').toUpperCase()}_`)) throw httpError(422, 'Use a secret reference belonging to this business.');
        record(store, "connector", `Updated connector: ${connector.name}`, { connectorId: connector.id }); await saveStore(store);
        return reply(res, 200, { connector: publicConnector(connector) });
      }

      if (req.method === "POST" && pathname === "/api/feedback") {
        if (!requireOperator(req, res)) return;
        const input = await readJson(req); const store = await loadStore();
        const feedback = {
          id: randomUUID(), productId: sanitizeText(input.productId, "Product", { min: 2, max: 80 }),
          source: sanitizeText(input.source, "Feedback source", { min: 2, max: 50 }),
          sentiment: sanitizeText(input.sentiment, "Sentiment", { min: 3, max: 20 }).toLowerCase(),
          text: sanitizeText(input.text, "Feedback", { min: 3, max: 2_000 }),
          themes: sanitizeArray(input.themes, "Feedback themes", 6), createdAt: now(),
        };
        findProduct(store, feedback.productId); store.feedback.unshift(feedback); record(store, "feedback", `Recorded ${feedback.sentiment} feedback from ${feedback.source}`, { feedbackId: feedback.id }); await saveStore(store);
        return reply(res, 201, { feedback });
      }

      if (pathname.startsWith("/api/")) return fail(res, 404, "API route not found.");
      return serveStatic(req, res, pathname);
    } catch (error) {
      if (databaseEnabled) throw error;
      const status = error instanceof TypeError ? 400 : 422;
      return fail(res, status, error.message || "Unexpected server error.");
    } finally {
      release?.();
    }
}

export async function performQueuedAction(job) {
  const user = (await pool.query('SELECT id,email FROM app_users WHERE id=$1', [job.userId])).rows[0];
  if (!user) throw httpError(403, 'The requesting user no longer exists.');
  return withBusiness(user, job.businessId, true, async () => {
    requireRole(...(job.action === 'run' ? ['owner'] : ['owner', 'editor']));
    const { client } = context.getStore();
    const state = (await client.query('SELECT state FROM app_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0]?.state;
    if (state !== 'queued') return;
    const store = await loadStore();
    const campaign = findCampaign(store, job.campaignId);
    const product = findProduct(store, campaign.productId);
    if (job.action === 'plan') {
      if (!['draft', 'planned'].includes(campaign.status)) throw httpError(409, 'Campaign is no longer available for planning.');
      campaign.businessSnapshot = structuredClone(findBusiness(store, campaign.businessId));
      campaign.plan = await createPlan(campaign, product);
      campaign.status = 'planned';
    } else if (job.action === 'prepare') {
      if (campaign.status !== 'approved') throw httpError(409, 'Campaign must be approved.');
      campaign.execution = { payload: await createExecutionPayload(campaign, product), preparedAt: now(), results: [] };
      campaign.status = 'prepared';
    } else {
      if (campaign.status !== 'prepared') throw httpError(409, 'Campaign must be prepared.');
      if (campaign.dailyBudget > maxDailyBudget) throw httpError(422, 'Campaign exceeds the server budget cap.');
      if (liveMode) throw httpError(422, 'Live delivery requires a verified provider adapter.');
      campaign.execution.results = campaign.channels.map((id) => ({ connectorId: id, mode: 'simulation', payloadAccepted: true }));
      campaign.status = 'simulated';
    }
    campaign.updatedAt = now();
    record(store, 'job', `Completed ${job.action}: ${campaign.name}`, { campaignId: campaign.id, jobId: job.id });
    await saveStore(store);
    await client.query("UPDATE app_jobs SET state='completed',completed_at=now() WHERE id=$1", [job.id]);
  });
}

export function createApp() {
  if (databaseEnabled && liveMode) throw new Error('Database mode currently supports reviewed simulations. Live mode requires a verified provider adapter.');
  if (process.env.NODE_ENV === 'production' && (!databaseEnabled || !process.env.APP_ORIGIN?.startsWith('https://'))) throw new Error('Production requires DATABASE_URL and an HTTPS APP_ORIGIN.');
  const app = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (!databaseEnabled) return handleRequest(req, res);
    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        await pool.query('SELECT version FROM app_migrations WHERE version=1');
        return reply(res, 200, { ok: true, database: 'postgresql', liveMode: false });
      }
      if (pathname === '/api/ready' && req.method === 'GET') {
        const ready = (await pool.query("SELECT id FROM app_worker_health WHERE seen_at > now()-interval '30 seconds' LIMIT 1")).rowCount > 0;
        return reply(res, ready ? 200 : 503, { ok: ready, database: 'postgresql', worker: ready ? 'ready' : 'unavailable' });
      }
      if (pathname === '/api/auth/config' && req.method === 'GET') return reply(res, 200, { required: true, signup: process.env.ALLOW_SIGNUP === 'true' });
      const auth = pathname.match(/^\/api\/auth\/(login|register|logout)$/);
      if (auth && req.method === 'POST') return reply(res, 200, await authAction(req, res, auth[1], await readJson(req)));
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
      let user;
      try { user = await authenticate(req); }
      catch (error) {
        if (pathname === '/api/auth/me' && req.method === 'GET' && error.status === 401) return reply(res, 200, { user: null });
        throw error;
      }
      if (pathname === '/api/auth/me' && req.method === 'GET') return reply(res, 200, { user });
      const write = !['GET', 'HEAD'].includes(req.method);
      if (write) checkOrigin(req);
      const response = await withBusiness(user, req.headers['x-business-id'], write, async () => {
        await handleRequest(req, res);
        return context.getStore().response;
      });
      reply(res, response.status, response.payload);
    } catch (error) {
      const status = error.status || (error.code ? 500 : 422);
      if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId, code: error.code || 'INTERNAL' }));
      reply(res, status, { error: status >= 500 ? 'Request failed. Please retry or contact the operator.' : error.message, requestId });
    }
  });
  app.requestTimeout = 30000;
  app.headersTimeout = 15000;
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (databaseEnabled) { await migrate(); await startQueue(); }
  const app = createApp();
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`PR Activity running at http://localhost:${port}`));
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.close(async () => { await stopQueue(); await pool?.end(); process.exit(0); });
  });
}

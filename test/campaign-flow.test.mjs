import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let app;
let baseUrl;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "campaign-command-center-"));
  process.env.CAMPAIGN_STORE_PATH = path.join(temporaryDirectory, "store.json");
  process.env.ENABLE_LIVE_CONNECTORS = "false";
  const { createApp } = await import(`../server.mjs?test=${Date.now()}`);
  app = createApp();
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  await new Promise((resolve) => app.close(resolve));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function request(pathname, method = "GET", body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

test("runs a reviewed campaign through the safe simulation path", async () => {
  const health = await request("/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.liveMode, false);

  const created = await request("/api/campaigns", "POST", {
    name: "Demo sales campaign",
    productId: "demo-offer",
    goal: "sales",
    audience: "Small businesses seeking a simple service package",
    offer: "A transparent starter service with a clear delivery scope",
    channels: ["meta"],
    dailyBudget: 25,
  });
  assert.equal(created.response.status, 201);
  const campaignId = created.body.campaign.id;

  const planned = await request(`/api/campaigns/${campaignId}/plan`, "POST", {});
  assert.equal(planned.body.campaign.status, "planned");
  assert.equal(planned.body.campaign.plan.source, "deterministic fallback");

  const approved = await request(`/api/campaigns/${campaignId}/approve`, "POST", { approvedBy: "Test operator" });
  assert.equal(approved.body.campaign.status, "approved");

  const prepared = await request(`/api/campaigns/${campaignId}/prepare`, "POST", {});
  assert.equal(prepared.body.campaign.status, "prepared");
  assert.equal(prepared.body.campaign.execution.payload.dailyBudget, 25);

  const executed = await request(`/api/campaigns/${campaignId}/run`, "POST", { confirmation: "RUN" });
  assert.equal(executed.response.status, 200);
  assert.equal(executed.body.mode, "simulation");
  assert.equal(executed.body.campaign.status, "simulated");

  const results = await request(`/api/campaigns/${campaignId}/metrics`, "POST", { spend: 25, leads: 8, conversions: 2, revenue: 300 });
  assert.equal(results.body.campaign.metrics.revenue, 300);
  const dashboard = await request("/api/dashboard");
  assert.equal(dashboard.body.totals.roas, 12);
});

test("refuses a campaign run without explicit confirmation", async () => {
  const created = await request("/api/campaigns", "POST", {
    name: "Confirmation gate test",
    productId: "demo-offer",
    goal: "leads",
    audience: "Teams looking for a measurable service outcome",
    offer: "A discovery call with stated deliverables",
    channels: ["meta"],
    dailyBudget: 10,
  });
  const campaignId = created.body.campaign.id;
  await request(`/api/campaigns/${campaignId}/plan`, "POST", {});
  await request(`/api/campaigns/${campaignId}/approve`, "POST", { approvedBy: "Test operator" });
  await request(`/api/campaigns/${campaignId}/prepare`, "POST", {});
  const rejected = await request(`/api/campaigns/${campaignId}/run`, "POST", { confirmation: "GO" });
  assert.equal(rejected.response.status, 422);
  assert.match(rejected.body.error, /Type RUN/);
});

const state = { dashboard: null, operatorToken: "", businessId: "default-business", authRequired: false, user: null, jobs: [] };
let registerMode = false;
let jobPoll;
let scheduledCampaign;
const $ = (selector) => document.querySelector(selector);

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}

function money(value) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currentBusiness()?.currency || "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function currentBusiness() {
  return state.dashboard?.businesses.find((business) => business.id === state.businessId);
}

function editBusiness(business = {}) {
  const form = $("#business-form");
  form.reset();
  for (const element of form.elements) element.disabled = business.role === 'viewer' && element.id !== 'cancel-business';
  for (const field of ["id", "name", "industry", "audience", "geography", "language", "tone", "currency", "dailyBudget"]) {
    form.elements[field].value = business[field] ?? ({ currency: "USD", dailyBudget: 25 }[field] ?? "");
  }
  const channels = clear($("#business-channels"));
  for (const connector of state.dashboard.connectors) {
    const input = node("input", { type: "checkbox", name: "channels", value: connector.id });
    input.checked = (business.channels || []).includes(connector.id);
    channels.append(node("label", {}, [input, connector.name]));
  }
}

function applyBusinessDefaults() {
  const business = currentBusiness();
  const form = $("#campaign-form");
  form.elements.audience.value = business?.audience || "";
  form.elements.dailyBudget.value = business?.dailyBudget ?? "";
  renderChannels(state.dashboard.connectors);
}

function dateTime(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function clear(element) { element.replaceChildren(); return element; }

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => { toast.className = "toast"; }, 4_000);
}

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.authRequired && state.businessId && state.businessId !== 'default-business') headers['x-business-id'] = state.businessId;
  if (state.operatorToken) headers["x-admin-token"] = state.operatorToken;
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && state.authRequired) showLogin();
  if (!response.ok) throw new Error(body.detail || body.error || `Request failed (${response.status})`);
  return body;
}

async function refresh() {
  try {
    state.dashboard = await api("/api/dashboard");
    if (state.authRequired) state.businessId = state.dashboard.selectedBusinessId;
    render();
    if (state.authRequired) { await refreshJobs(); await refreshMembers(); }
  } catch (error) {
    showToast(error.message, true);
  }
}

function render() {
  const data = state.dashboard;
  const { safeguards } = data;
  const select = clear($("#business-select"));
  for (const business of data.businesses) select.append(node("option", { value: business.id, text: business.name }));
  select.value = state.businessId;
  if (!data.businesses.length) {
    select.append(node('option', { text: 'No businesses yet', value: '' }));
    editBusiness();
    $('#business-editor').open = true;
  }
  const products = data.products.filter((product) => product.businessId === state.businessId);
  const campaigns = data.campaigns.filter((campaign) => campaign.businessId === state.businessId);
  const totals = campaigns.reduce((total, campaign) => {
    for (const key of ["revenue", "spend", "leads", "conversions"]) total[key] += campaign.metrics?.[key] || 0;
    return total;
  }, { revenue: 0, spend: 0, leads: 0, conversions: 0 });
  totals.roas = totals.spend ? Math.round(totals.revenue / totals.spend * 100) / 100 : null;
  $("#metric-revenue").textContent = money(totals.revenue);
  $("#metric-spend").textContent = money(totals.spend);
  $("#metric-roas").textContent = totals.roas === null ? "—" : `${totals.roas}×`;
  $("#metric-leads").textContent = `${totals.leads} / ${totals.conversions}`;
  $("#mode-badge").textContent = safeguards.liveMode ? "LIVE CONNECTORS ENABLED" : "SIMULATION MODE";
  $("#mode-badge").style.color = safeguards.liveMode ? "#ffad82" : "#d6ff55";

  const notice = clear($("#safeguards"));
  notice.append(node("strong", { text: safeguards.liveMode ? "Live mode is active. " : "Simulation is active. " }));
  notice.append(document.createTextNode(safeguards.liveMode
    ? `Publishing still needs operator authorization, approval, RUN confirmation, configured token references, and a ${money(safeguards.maxDailyBudget)} daily cap.`
    : `Campaign runs will be recorded without calling an external platform. The server cap is ${money(safeguards.maxDailyBudget)} per day.`));

  renderProducts(products);
  renderChannels(data.connectors);
  renderCampaigns(campaigns);
  const feedback = data.feedback.filter((item) => products.some((product) => product.id === item.productId));
  const themes = {};
  for (const item of feedback) for (const theme of item.themes || []) themes[theme] = (themes[theme] || 0) + 1;
  renderFeedback(feedback, Object.entries(themes).map(([theme, count]) => ({ theme, count })));
  renderActivity(data.activity);
  renderConnectors(data.connectors);
  if (!$("#business-editor").open) editBusiness(currentBusiness());
  if (!$("#campaign-form").elements.audience.value) applyBusinessDefaults();
  $("#campaign-form").querySelector('button[type="submit"]').disabled = !products.length;
  if (state.authRequired) {
    const role = currentBusiness()?.role;
    for (const id of ['product-form', 'campaign-form', 'feedback-form']) {
      for (const element of $('#' + id).elements) element.disabled = !['owner', 'editor'].includes(role);
    }
    $('#campaign-form').querySelector('button[type="submit"]').disabled ||= !products.length;
    for (const element of $('#connector-list').querySelectorAll('input,button')) element.disabled = role !== 'owner';
    $('#team-section').hidden = role !== 'owner';
    $('#jobs-section').hidden = false;
  }
}

function renderProducts(products) {
  for (const select of [$("#campaign-product"), $("#feedback-product")]) {
    clear(select);
    for (const product of products) {
      const label = product.price ? `${product.name} · ${money(product.price)}` : product.name;
      select.append(node("option", { value: product.id, text: label }));
    }
  }
}

function renderChannels(connectors) {
  const container = clear($("#channel-options"));
  for (const connector of connectors) {
    const input = node("input", { type: "checkbox", name: "channels", value: connector.id, id: `channel-${connector.id}` });
    input.checked = (currentBusiness()?.channels || []).includes(connector.id);
    container.append(node("label", { for: input.id }, [input, document.createTextNode(connector.name)]));
  }
}

function campaignAction(campaign) {
  if (state.authRequired) {
    const role = currentBusiness()?.role;
    if (role === 'viewer' || !role || (role !== 'owner' && ['planned', 'prepared'].includes(campaign.status))) return null;
    if (state.jobs.some((job) => job.campaign_id === campaign.id && job.state === 'queued')) return null;
  }
  if (campaign.status === "draft") return { label: "Plan with GPT", action: "plan", className: "primary" };
  if (campaign.status === "planned") return { label: "Approve brief", action: "approve", className: "secondary" };
  if (campaign.status === "approved") return { label: "Prepare with executor", action: "prepare", className: "secondary" };
  if (campaign.status === "prepared") return { label: "Run campaign", action: "run", className: "primary" };
  return null;
}

function renderCampaigns(campaigns) {
  $("#campaign-count").textContent = `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`;
  const container = clear($("#campaign-list"));
  if (!campaigns.length) {
    container.append(node("div", { className: "empty-state", text: "No campaigns yet. Create a brief above to begin." }));
    return;
  }
  for (const campaign of campaigns) {
    const card = node("article", { className: "campaign-card" });
    const top = node("div", { className: "campaign-top" });
    top.append(node("div", {}, [node("h3", { text: campaign.name }), node("p", { className: "eyebrow", text: campaign.goal })]));
    top.append(node("span", { className: `status ${campaign.status}`, text: campaign.status }));
    const description = node("p", { className: "description", text: campaign.offer });
    const meta = node("div", { className: "campaign-meta" }, [
      node("span", { text: campaign.audience }), node("span", { text: `• ${money(campaign.dailyBudget)}/day` }), node("span", { text: `• ${campaign.channels.join(", ")}` }),
    ]);
    const actions = node("div", { className: "card-actions" });
    if (state.authRequired && campaign.status === 'prepared' && currentBusiness()?.role === 'owner') actions.append(node('button', { className: 'button secondary', type: 'button', text: 'Schedule', onClick: () => { scheduledCampaign = campaign; $('#schedule-dialog').showModal(); } }));
    if (campaign.plan || campaign.execution) actions.append(node("button", { className: "button ghost", type: "button", text: "View detail", onClick: () => openDetail(campaign) }));
    if (["simulated", "live"].includes(campaign.status)) actions.append(node("button", { className: "button ghost", type: "button", text: "Record results", onClick: () => openMetrics(campaign) }));
    const action = campaignAction(campaign);
    if (action) actions.append(node("button", { className: `button ${action.className}`, type: "button", text: action.label, onClick: () => doCampaignAction(campaign, action.action) }));
    card.append(top, description, meta, actions);
    container.append(card);
  }
}

function renderFeedback(feedback, themes) {
  $("#feedback-count").textContent = `${feedback.length} item${feedback.length === 1 ? "" : "s"}`;
  const themeList = clear($("#theme-list"));
  if (!themes.length) themeList.append(node("p", { className: "muted", text: "Feedback themes will appear here after the first entry." }));
  for (const item of themes) themeList.append(node("span", { className: "theme" }, [document.createTextNode(item.theme), node("b", { text: item.count })]));
}

function renderActivity(activity) {
  const container = clear($("#activity-list"));
  if (!activity.length) return container.append(node("p", { className: "muted", text: "No activity recorded." }));
  for (const item of activity) {
    const row = node("div", { className: "activity-row" });
    row.append(node("span", { className: "activity-icon" }), node("div", {}, [node("p", { text: item.message }), node("time", { text: dateTime(item.at) })]));
    container.append(row);
  }
}

function renderConnectors(connectors) {
  const container = clear($("#connector-list"));
  for (const connector of connectors) {
    const readiness = connector.ready ? "Ready" : connector.tokenConfigured ? "Needs API URL" : "Not configured";
    const card = node("article", { className: "connector" });
    card.append(node("div", { className: "connector-head" }, [
      node("div", {}, [node("h3", { text: connector.name }), node("p", { text: connector.type })]),
      node("span", { className: `status ${connector.ready ? "simulated" : "draft"}`, text: readiness }),
    ]));
    const form = node("form");
    const apiUrl = node("input", { name: "apiBaseUrl", value: connector.apiBaseUrl, placeholder: "API base URL" });
    const secretRef = node("input", { name: "secretRef", value: connector.secretRef, placeholder: "SECRET_REFERENCE" });
    form.append(apiUrl, secretRef, node("button", { className: "button ghost", type: "submit", text: "Save" }));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api(`/api/connectors/${connector.id}`, { method: "PUT", body: JSON.stringify({ apiBaseUrl: apiUrl.value, secretRef: secretRef.value }) });
        showToast(`${connector.name} configuration saved.`); await refresh();
      } catch (error) { showToast(error.message, true); }
    });
    card.append(form); container.append(card);
  }
}

function paragraph(title, value) {
  return node("section", {}, [node("h3", { text: title }), node("p", { text: value || "Not available." })]);
}

function openDetail(campaign) {
  const content = clear($("#plan-content"));
  content.append(node("p", { className: "eyebrow", text: `CAMPAIGN DETAIL · ${campaign.status}` }), node("h2", { text: campaign.name }), paragraph("Offer", campaign.offer));
  if (campaign.plan) {
    content.append(paragraph("Positioning", campaign.plan.positioning), paragraph("Primary message", campaign.plan.primaryMessage), paragraph("Creative brief", campaign.plan.creativeBrief), paragraph("Landing-page brief", campaign.plan.landingPageBrief));
    const experiments = node("section", {}, [node("h3", { text: "Experiments" })]);
    const list = node("ul");
    for (const experiment of campaign.plan.experiments || []) list.append(node("li", { text: `${experiment.hypothesis} Measure: ${experiment.successMetric}.` }));
    experiments.append(list); content.append(experiments);
  }
  if (campaign.execution) {
    content.append(node("section", {}, [node("h3", { text: "Executor payload" }), node("pre", { text: JSON.stringify(campaign.execution.payload, null, 2) })]));
    if (campaign.execution.results?.length) content.append(node("section", {}, [node("h3", { text: "Run result" }), node("pre", { text: JSON.stringify(campaign.execution.results, null, 2) })]));
  }
  $("#plan-dialog").showModal();
}

function openMetrics(campaign) {
  $("#metrics-title").textContent = `Record results · ${campaign.name}`;
  $("#metrics-campaign-id").value = campaign.id;
  const form = $("#metrics-form");
  for (const field of ["spend", "leads", "conversions", "revenue"]) form.elements[field].value = campaign.metrics?.[field] || 0;
  $("#metrics-dialog").showModal();
}

async function doCampaignAction(campaign, action) {
  try {
    let body = {};
    if (action === "approve" && !state.authRequired) {
      const approvedBy = window.prompt("Record the approving operator name:", "operator");
      if (!approvedBy) return;
      body = { approvedBy };
    }
    if (action === "run") {
      const confirmation = window.prompt("Type RUN to confirm this campaign execution:");
      if (confirmation !== "RUN") return showToast("Campaign not run. Confirmation must be RUN.", true);
      body = { confirmation };
    }
    const result = await api(`/api/campaigns/${campaign.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
    const descriptions = { plan: "Campaign strategy created.", approve: "Campaign approved.", prepare: "Connector payload prepared.", run: result.mode === "live" ? "Campaign published live." : "Campaign simulated; no external call was made." };
    showToast(result.job ? 'Campaign action queued.' : descriptions[action]); await refresh();
  } catch (error) { showToast(error.message, true); }
}

$("#operator-key").addEventListener("click", () => {
  const value = window.prompt("Enter the operator token. It is retained only until this tab is refreshed:", "");
  if (value !== null) { state.operatorToken = value; showToast(value ? "Operator key set for this tab." : "Operator key cleared."); }
});

$("#campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const channels = form.getAll("channels");
  if (!channels.length) return showToast("Choose at least one channel.", true);
  try {
    await api("/api/campaigns", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(form), businessId: state.businessId, channels }) });
    formElement.reset(); showToast("Campaign brief created. Ask GPT to plan it next."); await refresh();
  } catch (error) { showToast(error.message, true); }
});

$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const result = await api("/api/products", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(formElement)), businessId: state.businessId }) });
    formElement.reset(); showToast(`${result.product.name} is ready for campaign briefs.`); await refresh();
  } catch (error) { showToast(error.message, true); }
});

$("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = Object.fromEntries(new FormData(formElement));
  const themes = String(form.themes).split(",").map((theme) => theme.trim()).filter(Boolean);
  try {
    await api("/api/feedback", { method: "POST", body: JSON.stringify({ ...form, themes }) });
    formElement.reset(); showToast("Customer feedback recorded."); await refresh();
  } catch (error) { showToast(error.message, true); }
});

$("#metrics-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const campaignId = $("#metrics-campaign-id").value;
  try {
    await api(`/api/campaigns/${campaignId}/metrics`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(formElement))) });
    $("#metrics-dialog").close(); showToast("Campaign results recorded."); await refresh();
  } catch (error) { showToast(error.message, true); }
});

$("#business-select").addEventListener("change", async (event) => {
  state.businessId = event.target.value;
  $("#business-editor").open = false;
  $("#campaign-form").reset();
  if (state.authRequired) await refresh(); else render();
  applyBusinessDefaults();
});
$("#new-business").addEventListener("click", () => {
  editBusiness();
  $("#business-editor").open = true;
  $("#business-form").elements.name.focus();
});
$("#cancel-business").addEventListener("click", () => {
  $("#business-editor").open = false;
  editBusiness(currentBusiness());
});
$("#business-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const input = { ...Object.fromEntries(form), channels: form.getAll("channels") };
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(input.id ? `/api/businesses/${input.id}` : "/api/businesses", { method: input.id ? "PUT" : "POST", body: JSON.stringify(input) });
    state.businessId = result.business.id;
    $("#business-editor").open = false;
    $("#campaign-form").reset();
    await refresh();
    applyBusinessDefaults();
    showToast("Business saved.");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

function showLogin() {
  registerMode = false;
  $('#auth-title').textContent = 'Sign in';
  $('#auth-form button[type=submit]').textContent = 'Sign in';
  $('#auth-switch').textContent = 'Create account';
  state.user = null;
  state.dashboard = null;
  state.jobs = [];
  state.businessId = null;
  clearTimeout(jobPoll);
  $('.app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

async function refreshJobs() {
  clearTimeout(jobPoll);
  const { jobs } = await api('/api/jobs');
  const changed = JSON.stringify(state.jobs) !== JSON.stringify(jobs);
  state.jobs = jobs;
  const container = clear($('#job-list'));
  if (!jobs.length) container.append(node('p', { className: 'muted', text: 'No campaign jobs.' }));
  for (const job of jobs) {
    const campaign = state.dashboard.campaigns.find((entry) => entry.id === job.campaign_id);
    const row = node('div', { className: 'job-row' }, [node('p', { text: `${campaign?.name || job.campaign_id} / ${job.action} / ${job.state}${job.scheduled_at ? ' / ' + dateTime(job.scheduled_at) : ''}${job.error ? ': ' + job.error : ''}` })]);
    if (job.state === 'queued' && currentBusiness()?.role !== 'viewer') row.append(node('button', { className: 'button ghost', type: 'button', text: 'Cancel', onClick: async () => {
      try { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }); await refresh(); }
      catch (error) { showToast(error.message, true); }
    } }));
    container.append(row);
  }
  if (changed) renderCampaigns(state.dashboard.campaigns);
  if (jobs.some((job) => job.state === 'queued')) jobPoll = setTimeout(async () => {
    try {
      await refreshJobs();
      if (!state.jobs.some((job) => job.state === 'queued')) await refresh();
    } catch (error) { showToast(error.message, true); }
  }, 2000);
}

async function refreshMembers() {
  if (currentBusiness()?.role !== 'owner') return;
  const { members } = await api('/api/members');
  const list = clear($('#member-list'));
  for (const member of members) {
    const row = node('div', { className: 'job-row' }, [node('p', { text: `${member.email} / ${member.role}` })]);
    if (member.role !== 'owner') row.append(node('button', { className: 'button ghost', type: 'button', text: 'Remove', onClick: async () => {
      try { await api('/api/members', { method: 'DELETE', body: JSON.stringify({ userId: member.id }) }); await refreshMembers(); }
      catch (error) { showToast(error.message, true); }
    } }));
    list.append(row);
  }
}
$('#member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await api('/api/members', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await refreshMembers(); }
  catch (error) { showToast(error.message, true); }
});
$('#refresh-jobs').addEventListener('click', () => refresh().catch((error) => showToast(error.message, true)));
$('#auth-switch').addEventListener('click', () => {
  registerMode = !registerMode;
  $('#auth-title').textContent = registerMode ? 'Create account' : 'Sign in';
  $('#auth-form button[type=submit]').textContent = registerMode ? 'Create account' : 'Sign in';
  $('#auth-switch').textContent = registerMode ? 'Sign in' : 'Create account';
  $('#auth-form [name=password]').autocomplete = registerMode ? 'new-password' : 'current-password';
});
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type=submit]');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const result = await api(`/api/auth/${registerMode ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    state.user = result.user;
    state.businessId = null;
    event.target.reset();
    $('#auth-screen').hidden = true;
    $('.app-shell').hidden = false;
    await refresh();
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#sign-out').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); showLogin(); }
  catch (error) { showToast(error.message, true); }
});
$('#cancel-schedule').addEventListener('click', () => $('#schedule-dialog').close());
$('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api(`/api/campaigns/${scheduledCampaign.id}/run`, { method: 'POST', body: JSON.stringify({ ...form, scheduledAt: new Date(form.scheduledAt).toISOString() }) });
    $('#schedule-dialog').close();
    await refresh();
  } catch (error) { showToast(error.message, true); }
});
async function boot() {
  try {
    const response = await fetch('/api/auth/config');
    const config = response.ok ? await response.json() : { required: false };
    state.authRequired = config.required;
    if (state.authRequired) {
      $('#operator-key').hidden = true;
      $('#sign-out').hidden = false;
      $('#auth-switch').hidden = !config.signup;
      try { state.user = (await api('/api/auth/me')).user; if (!state.user) { showLogin(); return; } }
      catch { showLogin(); return; }
      state.businessId = null;
    }
    await refresh();
  } catch (error) { showToast(error.message, true); }
}
boot();

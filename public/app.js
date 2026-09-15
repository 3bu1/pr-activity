const state = { dashboard: null, operatorToken: "" };
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
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
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
  if (state.operatorToken) headers["x-admin-token"] = state.operatorToken;
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || body.error || `Request failed (${response.status})`);
  return body;
}

async function refresh() {
  try {
    state.dashboard = await api("/api/dashboard");
    render();
  } catch (error) {
    showToast(error.message, true);
  }
}

function render() {
  const data = state.dashboard;
  const { totals, safeguards } = data;
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

  renderProducts(data.products);
  renderChannels(data.connectors);
  renderCampaigns(data.campaigns);
  renderFeedback(data.feedback, data.feedbackThemes);
  renderActivity(data.activity);
  renderConnectors(data.connectors);
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
    if (connector.id === "meta") input.checked = true;
    container.append(node("label", { for: input.id }, [input, document.createTextNode(connector.name)]));
  }
}

function campaignAction(campaign) {
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
    if (action === "approve") {
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
    showToast(descriptions[action]); await refresh();
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
    await api("/api/campaigns", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(form), channels }) });
    formElement.reset(); showToast("Campaign brief created. Ask GPT to plan it next."); await refresh();
  } catch (error) { showToast(error.message, true); }
});

$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const result = await api("/api/products", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(formElement))) });
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

refresh();

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("business settings persist and drive the shared campaign workflow", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pr-business-"));
  process.env.CAMPAIGN_STORE_PATH = path.join(directory, "store.json");
  process.env.ENABLE_LIVE_CONNECTORS = "false";
  delete process.env.OPENAI_API_KEY;
  delete process.env.APP_ADMIN_TOKEN;
  const { createApp } = await import("../server.mjs");
  let app = createApp();
  const listen = () => new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  await listen();
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${route}`, {
      method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...await response.json() };
  };
  try {
    const configurations = [
      { name: "Example Studio", industry: "Design", audience: "Independent retailers needing design", geography: "India", language: "Telugu", tone: "Direct", currency: "INR", channels: ["meta"], dailyBudget: 40 },
      { name: "Example Software", industry: "Software", audience: "Small teams evaluating workflow software", geography: "France", language: "French", tone: "Technical", currency: "EUR", channels: ["email"], dailyBudget: 15 },
    ];
    const businesses = await Promise.all(configurations.map((configuration) => request("/api/businesses", "POST", configuration)));
    assert.ok(businesses.every((result) => result.status === 201));
    assert.equal((await request("/api/dashboard")).businesses.length, 3);
    const campaigns = [];
    for (let index = 0; index < businesses.length; index++) {
      const business = businesses[index].business;
      const product = await request("/api/products", "POST", { businessId: business.id, name: "Example offer", price: 100, grossMargin: 50, capacity: "Ten slots", proof: "Published specification" });
      assert.equal(product.product.businessId, business.id);
      const brief = { businessId: business.id, productId: product.product.id, name: "Example campaign", goal: "leads", offer: "Book an introductory consultation" };
      const mismatch = await request("/api/campaigns", "POST", { ...brief, businessId: businesses[1 - index].business.id });
      assert.equal(mismatch.status, 422);
      const created = await request("/api/campaigns", "POST", brief);
      assert.equal(created.status, 201);
      assert.equal(created.campaign.audience, business.audience);
      assert.equal(created.campaign.dailyBudget, business.dailyBudget);
      assert.deepEqual(created.campaign.channels, business.channels);
      const route = `/api/campaigns/${created.campaign.id}`;
      const planned = await request(route + "/plan", "POST", {});
      assert.equal(planned.campaign.plan.businessContext.id, business.id);
      assert.ok(planned.campaign.plan.creativeBrief.includes(business.language));
      await request(route + "/approve", "POST", { approvedBy: "Test operator" });
      const edited = await request("/api/businesses/" + business.id, "PUT", { ...business, language: "English" });
      assert.equal(edited.status, 200);
      const prepared = await request(route + "/prepare", "POST", {});
      assert.equal(prepared.campaign.businessSnapshot.language, business.language);
      assert.equal(prepared.campaign.execution.payload.businessId, business.id);
      assert.equal(prepared.campaign.execution.payload.currency, business.currency);
      assert.equal((await request(route + "/run", "POST", { confirmation: "RUN" })).campaign.status, "simulated");
      assert.equal((await request(route + "/metrics", "POST", { spend: 10, leads: 2, conversions: 1, revenue: 100 })).campaign.businessId, business.id);
      assert.equal((await request("/api/businesses/" + business.id, "PUT", { ...business, currency: "USD" })).status, 422);
      campaigns.push(created.campaign.id);
    }
    assert.equal((await request("/api/businesses", "POST", { ...configurations[0], channels: ["unknown"] })).status, 422);
    const dashboard = await request("/api/dashboard");
    const firstBusiness = businesses[0].business;
    const override = await request("/api/campaigns", "POST", {
      businessId: firstBusiness.id,
      productId: dashboard.products.find((product) => product.businessId === firstBusiness.id).id,
      name: "Campaign with overrides", goal: "awareness", offer: "Explore the published service catalogue",
      audience: "A distinct audience for this campaign", channels: ["google"], dailyBudget: 8,
    });
    assert.equal(override.campaign.dailyBudget, 8);
    assert.deepEqual(override.campaign.channels, ["google"]);
    assert.equal(override.campaign.audience, "A distinct audience for this campaign");
    const refreshedPlan = await request(`/api/campaigns/${override.campaign.id}/plan`, "POST", {});
    assert.equal(refreshedPlan.campaign.plan.businessContext.language, "English");
    assert.ok(refreshedPlan.campaign.plan.primaryMessage.includes("A distinct audience"));
    await new Promise((resolve) => app.close(resolve));
    app = createApp();
    await listen();
    const restored = await request("/api/dashboard");
    assert.equal(restored.businesses.find((business) => business.id === businesses[0].business.id).language, "English");
    assert.ok(campaigns.every((id) => restored.campaigns.some((campaign) => campaign.id === id && campaign.status === "simulated")));
    const persisted = JSON.parse(await readFile(process.env.CAMPAIGN_STORE_PATH, "utf8"));
    assert.equal(persisted.businesses.length, 3);
    // A pre-business store must remain usable without losing existing offers.
    delete persisted.businesses;
    persisted.campaigns = [];
    persisted.products = [{ id: "legacy", name: "Legacy offer" }];
    await writeFile(process.env.CAMPAIGN_STORE_PATH, JSON.stringify(persisted));
    const legacy = await request("/api/dashboard");
    assert.equal(legacy.products[0].businessId, "default-business");
    assert.equal(legacy.businesses[0].id, "default-business");
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

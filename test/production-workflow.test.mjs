import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';

test('PostgreSQL authentication, business isolation, roles, and durable jobs', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const database = 'pr_test_' + Date.now();
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = '/' + database;
  process.env.DATABASE_URL = url.href;
  process.env.APP_ORIGIN = 'http://localhost:3012';
  process.env.ALLOW_SIGNUP = 'true';
  process.env.ENABLE_LIVE_CONNECTORS = 'false';
  delete process.env.OPENAI_API_KEY;
  const { migrate, pool } = await import('../lib/database.mjs');
  const { startQueue, startWorker, stopQueue } = await import('../lib/jobs.mjs');
  const { createApp, performQueuedAction } = await import('../server.mjs');
  let app;
  let base;
  const open = async () => { app = createApp(); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.address().port}`; };
  const request = async (route, method = 'GET', data, account, businessId, origin = process.env.APP_ORIGIN) => {
    const response = await fetch(base + route, { method, headers: {
      'content-type': 'application/json', origin,
      ...(account ? { cookie: account.cookie } : {}), ...(businessId ? { 'x-business-id': businessId } : {}),
    }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() };
  };
  try {
    await migrate(); await migrate(); await startQueue(); await open();
    assert.equal((await request('/api/dashboard')).status, 401);
    const owner = await request('/api/auth/register', 'POST', { email: 'owner@example.test', password: 'A-long-test-password-123' });
    const outsider = await request('/api/auth/register', 'POST', { email: 'other@example.test', password: 'Another-test-password-123' });
    const viewer = await request('/api/auth/register', 'POST', { email: 'viewer@example.test', password: 'Viewer-test-password-123' });
    assert.equal(owner.status, 200);
    assert.ok(owner.cookie);
    const config = { name: 'Private Business', channels: ['meta'], dailyBudget: 25, audience: 'Retail teams looking for software', language: 'French', currency: 'EUR' };
    assert.equal((await request('/api/businesses', 'POST', config, owner, null, 'https://evil.example')).status, 403);
    const created = await request('/api/businesses', 'POST', config, owner);
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.business.id;
    assert.equal((await request('/api/dashboard', 'GET', null, outsider, id)).status, 403);
    assert.equal((await request('/api/dashboard', 'GET', null, outsider)).businesses.length, 0);
    assert.equal((await request('/api/members', 'POST', { email: 'viewer@example.test', role: 'viewer' }, owner, id)).status, 200);
    const viewed = await request('/api/dashboard', 'GET', null, viewer, id);
    assert.equal(viewed.businesses[0].role, 'viewer');
    assert.equal((await request('/api/businesses/' + id, 'PUT', config, viewer, id)).status, 403);
    assert.equal((await request('/api/members', 'GET', null, viewer, id)).status, 403);
    await request('/api/members', 'POST', { email: 'viewer@example.test', role: 'editor' }, owner, id);
    const product = await request('/api/products', 'POST', { name: 'Service package', price: 100, grossMargin: 50, capacity: 'Ten slots', proof: 'Documented scope' }, viewer, id);
    assert.equal(product.status, 201, JSON.stringify(product));
    const campaign = await request('/api/campaigns', 'POST', { productId: product.product.id, name: 'Launch campaign', goal: 'leads', offer: 'Book a consultation' }, viewer, id);
    assert.equal(campaign.status, 201);
    const route = '/api/campaigns/' + campaign.campaign.id;
    const queued = await request(route + '/plan', 'POST', {}, viewer, id);
    assert.equal(queued.status, 202, JSON.stringify(queued));
    assert.equal((await request(route + '/plan', 'POST', {}, viewer, id)).job.id, queued.job.id);
    assert.equal((await request(route + '/metrics', 'POST', {}, outsider, id)).status, 403);
    // A web restart must not lose accepted work; start the worker only afterward.
    await new Promise((resolve) => app.close(resolve)); await open();
    assert.equal((await request('/api/jobs', 'GET', null, owner, id)).jobs[0].state, 'queued');
    await startWorker(performQueuedAction);
    const waitJob = async (jobId) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const jobs = (await request('/api/jobs', 'GET', null, owner, id)).jobs;
        const job = jobs.find((entry) => entry.id === jobId);
        if (job.state === 'completed') return;
        if (job.state === 'failed') assert.fail(job.error);
        await delay(100);
      }
      assert.fail('Job did not complete');
    };
    await waitJob(queued.job.id);
    const planned = (await request('/api/dashboard', 'GET', null, owner, id)).campaigns[0];
    assert.equal(planned.plan.businessContext.language, 'French');
    assert.equal((await request(route + '/approve', 'POST', {}, viewer, id)).status, 403);
    assert.equal((await request(route + '/approve', 'POST', { approvedBy: 'spoofed' }, owner, id)).campaign.approvedBy, owner.user.email);
    const prepared = await request(route + '/prepare', 'POST', {}, viewer, id);
    await waitJob(prepared.job.id);
    const later = await request(route + '/run', 'POST', { confirmation: 'RUN', scheduledAt: new Date(Date.now() + 3600000).toISOString() }, owner, id);
    assert.equal(later.status, 202);
    assert.equal((await request('/api/jobs/' + later.job.id + '/cancel', 'POST', {}, owner, id)).status, 200);
    const run = await request(route + '/run', 'POST', { confirmation: 'RUN' }, owner, id);
    await waitJob(run.job.id);
    assert.equal((await request('/api/dashboard', 'GET', null, owner, id)).campaigns[0].status, 'simulated');
    const metrics = await request(route + '/metrics', 'POST', { spend: 25, leads: 5, conversions: 1, revenue: 100 }, owner, id);
    assert.equal(metrics.campaign.metrics.revenue, 100);
    const revokeCampaign = await request('/api/campaigns', 'POST', { productId: product.product.id, name: 'Revocation test', goal: 'leads', offer: 'An approved service offer' }, viewer, id);
    const revokedJob = await request('/api/campaigns/' + revokeCampaign.campaign.id + '/plan', 'POST', { scheduledAt: new Date(Date.now() + 1000).toISOString() }, viewer, id);
    assert.equal((await request('/api/members', 'DELETE', { userId: viewer.user.id }, owner, id)).status, 200);
    assert.equal((await request('/api/dashboard', 'GET', null, viewer, id)).status, 403);
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = (await request('/api/jobs', 'GET', null, owner, id)).jobs.find((entry) => entry.id === revokedJob.job.id);
      if (job.state === 'failed') break;
      if (attempt === 59) assert.fail('Revoked user job did not fail');
      await delay(100);
    }
    assert.equal((await request('/api/auth/logout', 'POST', {}, owner)).status, 200);
    assert.equal((await request('/api/dashboard', 'GET', null, owner, id)).status, 401);
    const login = await request('/api/auth/login', 'POST', { email: 'owner@example.test', password: 'A-long-test-password-123' });
    assert.equal(login.status, 200);
    assert.equal((await request('/api/dashboard', 'GET', null, login, id)).campaigns.length, 2);
    const accounts = (await pool.query('SELECT password_hash FROM app_users')).rows;
    assert.ok(accounts.every((account) => !account.password_hash.includes('password')));
    const child = spawn(process.execPath, ['worker.mjs'], { cwd: new URL('..', import.meta.url), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('worker ready')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Worker exited before readiness: ' + errors)));
    });
    child.kill('SIGINT'); child.kill('SIGTERM');
    assert.equal(await exited, 0, errors);
    assert.equal(errors, '');
  } finally {
    if (app?.listening) await new Promise((resolve) => app.close(resolve));
    await stopQueue(); await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
  }
});

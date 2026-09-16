import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const databaseEnabled = Boolean(process.env.DATABASE_URL);
export const context = new AsyncLocalStorage();
export const pool = databaseEnabled ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }) : null;
pool?.on('error', (error) => console.error(JSON.stringify({ event: 'database_pool_error', code: error.code })));

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
export function requireRole(...roles) {
  const current = context.getStore();
  if (databaseEnabled && !roles.includes(current?.role)) throw httpError(403, 'Your business role does not allow this action.');
}

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(738492)');
    await client.query('CREATE TABLE IF NOT EXISTS app_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(new URL('../db/', import.meta.url))).filter((file) => /^\d+-.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const version = Number(file.split('-')[0]);
      if ((await client.query('SELECT version FROM app_migrations WHERE version=$1', [version])).rowCount) continue;
      await client.query(await readFile(new URL('../db/' + file, import.meta.url), 'utf8'));
      await client.query('INSERT INTO app_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [version]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function withBusiness(user, businessId, write, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '120s'");
    const memberships = (await client.query('SELECT b.data, m.role FROM app_businesses b JOIN app_memberships m ON m.business_id=b.id WHERE m.user_id=$1 ORDER BY b.id', [user.id])).rows;
    const selected = businessId ? memberships.find((row) => row.data.id === businessId) : memberships[0];
    if (businessId && !selected) throw httpError(403, 'Business access denied.');
    const id = selected?.data.id;
    if (write && id) {
      const locked = (await client.query('SELECT data FROM app_businesses WHERE id=$1 FOR UPDATE', [id])).rows[0];
      selected.data = locked.data;
      const membership = (await client.query('SELECT role FROM app_memberships WHERE business_id=$1 AND user_id=$2', [id, user.id])).rows[0];
      if (!membership) throw httpError(403, 'Business access denied.');
      selected.role = membership.role;
    }
    return await context.run({ client, user, businessId: id, role: selected?.role, memberships }, async () => {
      const result = await callback();
      await client.query('COMMIT');
      return result;
    });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function loadDatabaseStore(seed) {
  const current = context.getStore();
  if (current.store) return current.store;
  const store = { businesses: current.memberships.map((row) => ({ ...row.data, role: row.role })), products: [], campaigns: [], feedback: [], connectors: seed.connectors, activity: [] };
  if (current.businessId) store.connectors = store.connectors.map((connector) => ({ ...connector, secretRef: `MARKETING_${current.businessId.replaceAll('-', '').toUpperCase()}_${connector.id.toUpperCase()}_TOKEN` }));
  if (current.businessId) {
    const rows = (await current.client.query('SELECT kind,data FROM app_records WHERE business_id=$1 ORDER BY id', [current.businessId])).rows;
    for (const row of rows) {
      if (row.kind === 'connectors') store.connectors = store.connectors.filter((connector) => connector.id !== row.data.id);
      store[row.kind].push(row.data);
    }
  }
  store.campaigns.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  store.activity.sort((a, b) => b.at.localeCompare(a.at));
  current.original = structuredClone(store);
  current.store = store;
  return store;
}

export async function saveDatabaseStore(store) {
  const current = context.getStore();
  const { client, original, user } = current;
  for (const business of store.businesses) {
    const old = original.businesses.find((entry) => entry.id === business.id);
    if (JSON.stringify(old) === JSON.stringify(business)) continue;
    const { role: ignored, ...data } = business;
    if (old) {
      if (business.id !== current.businessId) throw httpError(403, 'Select the business before editing it.');
      requireRole('owner', 'editor');
      await client.query('UPDATE app_businesses SET data=$2 WHERE id=$1', [business.id, data]);
    } else {
      await client.query('INSERT INTO app_businesses(id,data) VALUES($1,$2)', [business.id, data]);
      await client.query("INSERT INTO app_memberships(business_id,user_id,role) VALUES($1,$2,'owner')", [business.id, user.id]);
      current.newBusinessId = business.id;
    }
  }
  for (const kind of ['products', 'campaigns', 'feedback', 'connectors', 'activity']) {
    for (const item of store[kind]) {
      const old = original[kind].find((entry) => entry.id === item.id);
      if (JSON.stringify(old) === JSON.stringify(item)) continue;
      const businessId = kind === 'activity' && current.newBusinessId ? current.newBusinessId : current.businessId;
      if (!businessId) throw httpError(403, 'Create or select a business first.');
      if (businessId !== current.newBusinessId) requireRole('owner', 'editor');
      if (item.businessId && item.businessId !== businessId) throw httpError(403, 'Record belongs to a different business.');
      await client.query('INSERT INTO app_records(business_id,kind,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(business_id,kind,id) DO UPDATE SET data=EXCLUDED.data', [businessId, kind, item.id, item]);
    }
  }
}

export async function rateLimit(key, maximum = 10) {
  const { rows } = await pool.query(`INSERT INTO app_rate_limits(key,count,resets_at) VALUES($1,1,now()+interval '1 minute')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN app_rate_limits.resets_at < now() THEN 1 ELSE app_rate_limits.count+1 END,
    resets_at=CASE WHEN app_rate_limits.resets_at < now() THEN now()+interval '1 minute' ELSE app_rate_limits.resets_at END RETURNING count`, [key]);
  if (rows[0].count > maximum) throw httpError(429, 'Too many requests. Try again in one minute.');
}

export async function members(method, input) {
  requireRole('owner');
  const { client, businessId, user } = context.getStore();
  if (method === 'POST') {
    if (!['editor', 'viewer'].includes(input.role)) throw httpError(422, 'Choose editor or viewer.');
    const target = (await client.query('SELECT id FROM app_users WHERE email=$1', [String(input.email || '').trim().toLowerCase()])).rows[0];
    if (!target) throw httpError(422, 'This user must create an account first.');
    await client.query("INSERT INTO app_memberships(business_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(business_id,user_id) DO UPDATE SET role=EXCLUDED.role WHERE app_memberships.role <> 'owner'", [businessId, target.id, input.role]);
  }
  if (method === 'DELETE') {
    if (input.userId === user.id) throw httpError(422, 'The owner cannot remove their own access.');
    await client.query("DELETE FROM app_memberships WHERE business_id=$1 AND user_id=$2 AND role <> 'owner'", [businessId, input.userId]);
  }
  return (await client.query('SELECT u.id,u.email,m.role FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.business_id=$1 ORDER BY u.email', [businessId])).rows;
}

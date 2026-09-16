import { randomUUID } from 'node:crypto';
import { passwordHash } from '../lib/auth.mjs';
import { migrate, pool } from '../lib/database.mjs';

const [action, suppliedEmail] = process.argv.slice(2);
const email = String(suppliedEmail || '').trim().toLowerCase();
if (!['create', 'reset'].includes(action) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: PR_PASSWORD=<secret> npm run user -- create|reset email');
try {
  await migrate();
  const hash = await passwordHash(process.env.PR_PASSWORD);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (action === 'create') await client.query('INSERT INTO app_users(id,email,password_hash) VALUES($1,$2,$3)', [randomUUID(), email, hash]);
    else {
      const result = await client.query('UPDATE app_users SET password_hash=$2 WHERE email=$1 RETURNING id', [email, hash]);
      if (!result.rowCount) throw new Error('Account not found.');
      await client.query('DELETE FROM app_sessions WHERE user_id=$1', [result.rows[0].id]);
    }
    await client.query('COMMIT');
    console.log('Account updated.');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} finally { await pool?.end(); }

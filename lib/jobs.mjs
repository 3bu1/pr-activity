import { PgBoss } from 'pg-boss';
import { randomUUID } from 'node:crypto';
import { context, databaseEnabled, pool, requireRole, httpError } from './database.mjs';

const queueName = 'campaign-actions';
let boss;
export async function startQueue() {
  if (!databaseEnabled || boss) return boss;
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  boss.on('error', (error) => console.error(JSON.stringify({ event: 'queue_error', code: error.code || 'QUEUE' })));
  await boss.start();
  await boss.createQueue(queueName, { retryLimit: 2, retryDelay: 5, retryBackoff: true, expireInSeconds: 120 });
  return boss;
}
export async function stopQueue() { if (boss) { await boss.stop(); boss = null; } }

export async function enqueue(campaign, action, input) {
  const { client, user, businessId } = context.getStore();
  const allowed = { plan: ['draft', 'planned'], prepare: ['approved'], run: ['prepared'] };
  if (!allowed[action].includes(campaign.status)) throw httpError(409, `Campaign cannot ${action} from ${campaign.status}.`);
  if (action === 'run' && input.confirmation !== 'RUN') throw httpError(422, 'Type RUN to confirm a campaign execution.');
  const startAfter = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  if (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 366 * 86400000) throw httpError(422, 'Choose a schedule within the next year.');
  const pending = (await client.query("SELECT * FROM app_jobs WHERE business_id=$1 AND campaign_id=$2 AND state='queued'", [businessId, campaign.id])).rows[0];
  if (pending) return pending;
  const id = randomUUID();
  const data = { id, campaignId: campaign.id, action, userId: user.id, businessId };
  await boss.send(queueName, data, { id, startAfter, db: { executeSql: (text, values) => client.query(text, values) } });
  return (await client.query('INSERT INTO app_jobs(id,business_id,user_id,campaign_id,action,scheduled_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [id, businessId, user.id, campaign.id, action, startAfter])).rows[0];
}
export async function listJobs() {
  const { client, businessId } = context.getStore();
  if (!businessId) return [];
  // Reconcile terminal queue failures, including worker termination and expired jobs.
  await client.query("UPDATE app_jobs a SET state='failed',error='Background action failed. Review the campaign and retry.',completed_at=now() FROM pgboss.job j WHERE a.id=j.id AND a.business_id=$1 AND a.state='queued' AND j.state='failed'", [businessId]);
  return (await client.query('SELECT * FROM app_jobs WHERE business_id=$1 ORDER BY created_at DESC LIMIT 50', [businessId])).rows;
}
export async function cancelJob(id) {
  requireRole('owner', 'editor');
  const { client, businessId } = context.getStore();
  const row = (await client.query("SELECT * FROM app_jobs WHERE id=$1 AND business_id=$2 AND state='queued' FOR UPDATE", [id, businessId])).rows[0];
  if (!row) throw httpError(409, 'Job is no longer queued.');
  await boss.cancel(queueName, id, { db: { executeSql: (text, values) => client.query(text, values) } });
  await client.query("UPDATE app_jobs SET state='cancelled',completed_at=now() WHERE id=$1", [id]);
  return { ok: true };
}
export async function startWorker(execute) {
  await startQueue();
  await boss.work(queueName, { pollingIntervalSeconds: 1 }, async ([job]) => {
    try { await execute(job.data); }
    catch (error) {
      console.error(JSON.stringify({ event: 'job_failed', jobId: job.id, code: error.status || error.code || 'ACTION' }));
      if (error.status >= 400 && error.status < 500) {
        await pool.query("UPDATE app_jobs SET state='failed',error=$2,completed_at=now() WHERE id=$1 AND state='queued'", [job.id, error.message]);
        return;
      }
      throw new Error('Campaign action failed. Review configuration and retry.');
    }
  });
}

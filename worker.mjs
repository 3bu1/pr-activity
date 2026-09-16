import { migrate, pool } from './lib/database.mjs';
import { startWorker, stopQueue } from './lib/jobs.mjs';
import { performQueuedAction } from './server.mjs';
import { randomUUID } from 'node:crypto';

if (!pool) throw new Error('DATABASE_URL is required for the worker.');
await migrate();
await startWorker(performQueuedAction);
const workerId = randomUUID();
async function heartbeat() {
  await pool.query('INSERT INTO app_worker_health(id,seen_at) VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET seen_at=now()', [workerId]);
  await pool.query("DELETE FROM app_worker_health WHERE seen_at < now()-interval '1 day'");
  await pool.query('DELETE FROM app_sessions WHERE expires_at<now()');
  await pool.query("DELETE FROM app_rate_limits WHERE resets_at<now()-interval '1 day'");
}
await heartbeat();
let heartbeatWork = Promise.resolve();
const timer = setInterval(() => {
  heartbeatWork = heartbeatWork.then(heartbeat).catch(() => console.error('Worker heartbeat failed'));
}, 10000);
timer.unref();
console.log('PR Activity worker ready');
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  await heartbeatWork;
  await stopQueue();
  await pool.query('DELETE FROM app_worker_health WHERE id=$1', [workerId]);
  await pool.end();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);

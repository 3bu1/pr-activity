import { spawn } from 'node:child_process';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Configure .env.local first.');
const children = ['server.mjs', 'worker.mjs'].map((file) => spawn(process.execPath, [file], { stdio: 'inherit', env: process.env }));
let stopping = false;
function stop() { if (!stopping) { stopping = true; for (const child of children) child.kill('SIGTERM'); } }
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
let remaining = children.length;
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; stop(); });
  child.on('exit', (code) => {
    if (code) process.exitCode = code;
    stop();
    if (--remaining === 0) process.exit(process.exitCode || 0);
  });
}

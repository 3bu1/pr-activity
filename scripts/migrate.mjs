import { migrate, pool } from '../lib/database.mjs';
try { await migrate(); console.log('Database migration complete.'); }
finally { await pool?.end(); }

import { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool, httpError, rateLimit } from './database.mjs';

const derive = promisify(scrypt);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const cookieName = 'pr_session';
export const appOrigin = process.env.APP_ORIGIN || 'http://localhost:3012';
const secure = new URL(appOrigin).protocol === 'https:';
export function checkOrigin(req) {
  if (req.headers.origin !== appOrigin || !String(req.headers['content-type']).startsWith('application/json')) throw httpError(403, 'A same-origin JSON request is required.');
}
function tokenFrom(req) {
  return (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
}
function cookie(token, maxAge) { return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`; }
export async function authenticate(req) {
  const token = tokenFrom(req);
  if (!/^[a-f0-9]{64}$/.test(token)) throw httpError(401, 'Sign in to continue.');
  const user = (await pool.query('SELECT u.id,u.email FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [hashToken(token)])).rows[0];
  if (!user) throw httpError(401, 'Your session has expired. Sign in again.');
  return user;
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw httpError(422, 'Use a password of 12 to 200 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${key.toString('hex')}`;
}
export async function authAction(req, res, action, input) {
  checkOrigin(req);
  await rateLimit('auth:' + req.socket.remoteAddress, 20);
  if (action === 'logout') {
    await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [hashToken(tokenFrom(req))]);
    res.setHeader('set-cookie', cookie('', 0));
    return { ok: true };
  }
  const email = String(input.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw httpError(422, 'Enter a valid email address.');
  await rateLimit('account:' + hashToken(email), 10);
  let user;
  if (action === 'register') {
    if (process.env.ALLOW_SIGNUP !== 'true') throw httpError(403, 'Account registration is disabled.');
    const hash = await passwordHash(input.password);
    try {
      user = (await pool.query('INSERT INTO app_users(id,email,password_hash) VALUES($1,$2,$3) RETURNING id,email', [randomUUID(), email, hash])).rows[0];
    } catch (error) { if (error.code === '23505') throw httpError(409, 'An account already exists. Sign in instead.'); throw error; }
  } else if (action === 'login') {
    user = (await pool.query('SELECT id,email,password_hash FROM app_users WHERE email=$1', [email])).rows[0];
    const [salt, hash] = (user?.password_hash || '00000000000000000000000000000000:' + '0'.repeat(128)).split(':');
    if (typeof input.password !== 'string' || input.password.length > 200) throw httpError(401, 'Invalid email or password.');
    const key = await derive(input.password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
    if (!user || !timingSafeEqual(key, Buffer.from(hash, 'hex'))) throw httpError(401, 'Invalid email or password.');
  } else throw httpError(404, 'Unknown authentication action.');
  const token = randomBytes(32).toString('hex');
  await pool.query('DELETE FROM app_sessions WHERE expires_at<now() OR token_hash=$1', [hashToken(tokenFrom(req))]);
  await pool.query("INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [hashToken(token), user.id]);
  res.setHeader('set-cookie', cookie(token, 28800));
  return { user: { id: user.id, email: user.email } };
}

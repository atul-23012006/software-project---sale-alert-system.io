const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'sid';
const SESSION_DAYS = 30;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = (stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// Only a hash of the token is stored, so a leaked sessions table can't be replayed
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS]
  );
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

async function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  setSessionCookie(req, res, '', 0);
}

// Sets req.user ({ user_id, name, email, phone_number }) when the session cookie is valid
async function loadUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  req.user = null;
  if (token) {
    const { rows } = await db.query(
      `SELECT u.user_id, u.name, u.email, u.phone_number
       FROM sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );
    req.user = rows[0] || null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  next();
}

// Throttles password guessing: 10 failed logins per email per 15 minutes
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function tooManyFailures(email) {
  const f = failures.get(email);
  if (f && Date.now() - f.first > FAIL_WINDOW_MS) failures.delete(email);
  return (failures.get(email)?.count || 0) >= FAIL_LIMIT;
}

function recordFailure(email) {
  const f = failures.get(email) || { count: 0, first: Date.now() };
  f.count++;
  failures.set(email, f);
}

// ---------- "Forgot password" ----------
const RESET_MINUTES = 30;

// New one-time reset token for the user (any earlier unused ones stop working).
// Returns the raw token for the emailed link; only its hash is stored.
async function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`DELETE FROM password_resets WHERE user_id = $1 OR expires_at < now()`, [userId]);
  await db.query(
    `INSERT INTO password_resets (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), userId, RESET_MINUTES]
  );
  return token;
}

// Sets the new password if the token is valid, unused and unexpired, and signs the
// account out everywhere. Returns false for a bad token. The UPDATE marks the token
// used in the same statement that checks it, so a link can't be used twice.
async function resetPassword(token, newPassword) {
  const hash = await hashPassword(newPassword);
  return db.transaction(async client => {
    const { rows: [r] } = await client.query(
      `UPDATE password_resets SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashToken(String(token || ''))]
    );
    if (!r) return false;
    await client.query(`UPDATE users SET password_hash = $2 WHERE user_id = $1`, [r.user_id, hash]);
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [r.user_id]);
    return true;
  });
}

// At most 3 reset emails per address per hour, so the form can't be used to spam someone
const RESET_LIMIT = 3;
const RESET_WINDOW_MS = 60 * 60 * 1000;
const resetRequests = new Map();

function resetRateLimited(email) {
  const now = Date.now();
  const recent = (resetRequests.get(email) || []).filter(t => now - t < RESET_WINDOW_MS);
  if (recent.length >= RESET_LIMIT) return true;
  recent.push(now);
  resetRequests.set(email, recent);
  return false;
}

module.exports = {
  hashPassword, verifyPassword, startSession, endSession, loadUser, requireUser,
  tooManyFailures, recordFailure, clearFailures: email => failures.delete(email),
  createPasswordReset, resetPassword, resetRateLimited, RESET_MINUTES,
};

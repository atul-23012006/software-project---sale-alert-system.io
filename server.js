require('dotenv').config();

const express = require('express');
const path = require('path');
const cron = require('node-cron');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { scrapeProduct, searchOtherStores } = require('./lib/scraper');
const { dispatchAlerts, dispatchEmailAlerts, refreshDeliveryStatus, smsEnabled } = require('./lib/notify');
const mailer = require('./lib/mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const STALE_DAYS = Number(process.env.STALE_DAYS) || 7;                       // "price hasn't changed" alert
const RESCRAPE_CRON = process.env.RESCRAPE_CRON || '0 */6 * * *';             // re-check every tracked product
const COMPARE_EVERY_HOURS = Number(process.env.COMPARE_EVERY_HOURS) || 24;    // re-search other stores
// Base of links in emails. Taken from config, never from the request's Host header, which
// an attacker could forge to make the reset link point at their own site.
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

app.set('trust proxy', 'loopback'); // so req.secure is right behind a local TLS proxy
app.use(express.json());

// Express 5 forwards rejected promises from async handlers to this
const api = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);


// 🔐 PAGE GUARDS — must run before express.static serves the files
const PRIVATE_PAGES = ['/', '/index.html', '/history.html', '/product.html'];
const AUTH_PAGES = ['/login.html', '/register.html', '/forgot.html'];

app.get(PRIVATE_PAGES, api(auth.loadUser), (req, res, next) => {
  if (req.user) return next();
  res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
});
app.get(AUTH_PAGES, api(auth.loadUser), (req, res, next) =>
  req.user ? res.redirect('/history.html') : next());

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', api(auth.loadUser));


// ---------- helpers ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Indian mobile numbers only (the app covers Indian stores): "+91 98765-43210" or
// "98765 43210" -> "+919876543210"; undefined if blank, null if invalid.
// Rejects slips like "+91 91 98765 43210" (country code twice), which Twilio would
// otherwise accept and quietly send nowhere.
const PHONE_ERROR = 'Enter a 10-digit Indian mobile number, e.g. +919876543210';
function normalizePhone(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  let phone = String(raw).replace(/[\s\-().]/g, '');
  if (/^0?[6-9]\d{9}$/.test(phone)) phone = '+91' + phone.slice(-10);
  return /^\+91[6-9]\d{9}$/.test(phone) ? phone : null;
}

const publicUser = u => ({ user_id: u.user_id, name: u.name, email: u.email, phone_number: u.phone_number });

// Product ids the user tracks; 404s keep other users' products invisible
async function trackedProduct(userId, productId) {
  const { rows } = await db.query(
    `SELECT p.*, t.target_price, t.created_at AS tracked_since
     FROM tracking t JOIN products p ON p.product_id = t.product_id
     WHERE t.user_id = $1 AND t.product_id = $2`,
    [userId, productId]
  );
  return rows[0];
}

// Stores one scrape result: refreshes product details and appends a
// price_history row only if the price moved since the last observation.
async function recordScrape(client, productId, json) {
  const hasPrice = typeof json.price === 'number' && json.price > 0;
  await client.query(
    `UPDATE products SET
       name = COALESCE(NULLIF($2, ''), name),
       site = COALESCE($3, site),
       currency = COALESCE($4, currency),
       original_price = CASE WHEN $5 THEN $6::numeric ELSE original_price END,
       offer          = CASE WHEN $5 THEN NULLIF($7, '') ELSE offer END,
       last_checked_at = CASE WHEN $5 THEN now() ELSE last_checked_at END
     WHERE product_id = $1`,
    [productId, (json.product_name || '').substring(0, 300), json.site || null, json.currency || null,
     hasPrice, json.original_price || null, json.offer || '']
  );
  if (!hasPrice) return;
  await client.query(
    `INSERT INTO price_history (product_id, price, original_price)
     SELECT $1, round($2::numeric, 2), $3
     WHERE round($2::numeric, 2) IS DISTINCT FROM
           (SELECT price FROM latest_prices WHERE product_id = $1)`,
    [productId, json.price, json.original_price || null]
  );
}

async function runAlertChecks() {
  await db.query(`SELECT check_alerts(), check_stale_prices($1), check_cheaper_elsewhere()`, [STALE_DAYS]);
  await dispatchAlerts();
  await dispatchEmailAlerts();
  await refreshDeliveryStatus();
}

const busy = new Set(); // "refresh:12" / "compare:12" — stops duplicate concurrent scrapes

async function exclusive(key, fn) {
  if (busy.has(key)) return { busy: true };
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

function refreshProduct(product) {
  return exclusive(`refresh:${product.product_id}`, async () => {
    const json = await scrapeProduct(product.url);
    await db.transaction(client => recordScrape(client, product.product_id, json));
    return json;
  });
}

// Searches the other stores for the product and records what they charge
function compareProduct(productId) {
  return exclusive(`compare:${productId}`, async () => {
    const { rows: [p] } = await db.query(
      `SELECT p.*, l.price FROM products p LEFT JOIN latest_prices l ON l.product_id = p.product_id
       WHERE p.product_id = $1`, [productId]);
    if (!p || !p.name) return { skipped: "The product name isn't known yet, so other stores can't be searched." };

    // The price lets the scraper reject absurd "similar" stand-ins (a phone case for a phone)
    const json = await searchOtherStores(p.name, p.site, p.price);
    if (!json.success) throw new Error(json.message || 'Comparison failed');

    await db.transaction(async client => {
      for (const r of json.results) {
        await client.query(
          `INSERT INTO competitor_prices (product_id, site, title, url, price, match_type, match_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [productId, r.site, r.title.substring(0, 300), r.url.substring(0, 1000), r.price,
           r.match_type === 'similar' ? 'similar' : 'exact', r.match ?? null]
        );
      }
      for (const [site, reason] of Object.entries(json.misses || {})) {
        // The store refused or was unreachable: we learned nothing, so keep showing the last
        // real result (with its older "checked" time) rather than replacing it with a blank
        const transient = /refused|couldn't be reached/.test(reason);
        if (transient && (await client.query(
          `SELECT 1 FROM competitor_prices WHERE product_id = $1 AND site = $2 AND note IS NULL LIMIT 1`,
          [productId, site])).rowCount) continue;
        await client.query(`INSERT INTO competitor_prices (product_id, site, note) VALUES ($1, $2, $3)`,
          [productId, site, String(reason).substring(0, 200)]);
      }
      // Drop leftovers from stores no longer searched (e.g. Myntra, which now refuses bots),
      // so the page only lists stores this comparison actually covered
      const searched = [...json.results.map(r => r.site), ...Object.keys(json.misses || {})];
      await client.query(`DELETE FROM competitor_prices WHERE product_id = $1 AND NOT (site = ANY($2))`,
        [productId, searched]);
      await client.query(`UPDATE products SET last_compared_at = now() WHERE product_id = $1`, [productId]);
    });
    await runAlertChecks();
    return json;
  });
}


// ---------- 🔐 AUTH ----------

app.post('/api/auth/register', api(async (req, res) => {
  const { name, email, password, phone_number } = req.body || {};
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const phone = normalizePhone(phone_number);

  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (phone === null) return res.status(400).json({ error: PHONE_ERROR });

  const hash = await auth.hashPassword(password);
  const displayName = typeof name === 'string' ? name.trim().substring(0, 100) || null : null;

  const result = await db.transaction(async client => {
    if ((await client.query(`SELECT 1 FROM users WHERE email = $1`, [mail])).rowCount) {
      return { error: 'An account with this email already exists' };
    }
    if (phone) {
      const { rows: [owner] } = await client.query(
        `SELECT user_id FROM users WHERE phone_number = $1 AND password_hash IS NULL LIMIT 1 FOR UPDATE`, [phone]);
      if (owner) {
        // Phone-only user from before accounts existed: claim it, keeping their tracked products
        await client.query(
          `UPDATE users SET name = $2, email = $3, password_hash = $4 WHERE user_id = $1`,
          [owner.user_id, displayName, mail, hash]);
        return { user_id: owner.user_id };
      }
    }
    const { rows: [u] } = await client.query(
      `INSERT INTO users (name, email, password_hash, phone_number) VALUES ($1, $2, $3, $4) RETURNING user_id`,
      [displayName, mail, hash, phone || null]);
    return u;
  });

  if (result.error) return res.status(409).json({ error: result.error });
  await auth.startSession(req, res, result.user_id);
  res.status(201).json({ user: { user_id: result.user_id, name: displayName, email: mail, phone_number: phone || null } });
}));

app.post('/api/auth/login', api(async (req, res) => {
  const { email, password } = req.body || {};
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!mail || typeof password !== 'string') return res.status(400).json({ error: 'Email and password are required' });
  if (auth.tooManyFailures(mail)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const { rows: [u] } = await db.query(`SELECT * FROM users WHERE email = $1`, [mail]);
  if (!u || !(await auth.verifyPassword(password, u.password_hash))) {
    auth.recordFailure(mail);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  auth.clearFailures(mail);
  await auth.startSession(req, res, u.user_id);
  res.json({ user: publicUser(u) });
}));

// "Forgot password?": emails a one-time reset link to the registered address.
// The reply is the same whether or not the email is registered, so the form can't be
// used to find out who has an account.
app.post('/api/auth/forgot', api(async (req, res) => {
  const mail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!mailer.mailEnabled) {
    return res.status(503).json({
      error: "Password-reset emails aren't set up on this server yet. Ask the site owner to reset it (npm run reset-password).",
    });
  }

  const done = () => res.json({
    message: `If ${mail} has an account, a reset link is on its way. It expires in ${auth.RESET_MINUTES} minutes — check your spam folder too.`,
  });
  if (auth.resetRateLimited(mail)) return done();

  const { rows: [u] } = await db.query(`SELECT user_id, name FROM users WHERE email = $1 AND password_hash IS NOT NULL`, [mail]);
  if (!u) return done();

  const token = await auth.createPasswordReset(u.user_id);
  try {
    await mailer.sendPasswordReset({
      to: mail, name: u.name, minutes: auth.RESET_MINUTES,
      link: `${APP_URL}/reset.html?token=${encodeURIComponent(token)}`,
    });
  } catch (err) {
    console.error('RESET EMAIL ERROR:', err.message);
    return res.status(502).json({ error: "The reset email couldn't be sent. Please try again later." });
  }
  done();
}));

app.post('/api/auth/reset', api(async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!(await auth.resetPassword(token, password))) {
    return res.status(400).json({ error: 'This reset link is invalid, already used or expired. Ask for a new one.' });
  }
  res.json({ ok: true });
}));

app.post('/api/auth/logout', api(async (req, res) => {
  await auth.endSession(req, res);
  res.json({ ok: true });
}));

app.get('/api/auth/me', auth.requireUser, (req, res) =>
  res.json({ user: publicUser(req.user), sms_enabled: smsEnabled }));

app.patch('/api/auth/me', auth.requireUser, api(async (req, res) => {
  const { name, phone_number } = req.body || {};
  const phone = normalizePhone(phone_number);
  if (phone === null) return res.status(400).json({ error: PHONE_ERROR });
  const { rows: [u] } = await db.query(
      `UPDATE users SET
         name = CASE WHEN $2 THEN $3 ELSE name END,
         phone_number = CASE WHEN $4 THEN $5 ELSE phone_number END
       WHERE user_id = $1 RETURNING *`,
      [req.user.user_id, typeof name === 'string', typeof name === 'string' ? name.trim().substring(0, 100) || null : null,
       phone_number !== undefined, phone || null]
    );
  res.json({ user: publicUser(u) });
}));


// ---------- 📦 TRACKING ----------

app.param('id', (req, res, next, id) =>
  /^\d{1,15}$/.test(id) ? next() : res.status(404).json({ error: 'Product not found' }));

app.post('/api/track', auth.requireUser, api(async (req, res) => {
  const { user_input, target_price } = req.body || {};
  const target = Number(target_price);
  if (typeof user_input !== 'string' || !user_input.trim() || !Number.isFinite(target) || target <= 0) {
    return res.status(400).json({ error: 'A product URL (or search text) and a positive target price are required' });
  }
  const input = user_input.trim().substring(0, 1000);

  const json = await scrapeProduct(input);
  // Non-Indian store, a store that refuses automated checks, or a page its robots.txt
  // puts off-limits: nothing to track, so don't save anything
  if (['unsupported', 'disallowed', 'blocked'].includes(json.error)) {
    return res.status(422).json({ error: json.message });
  }

  const productId = await db.transaction(async client => {
    const { rows: [p] } = await client.query(
      `INSERT INTO products (name, url, site) VALUES ($1, $2, $3)
       ON CONFLICT (url) DO UPDATE SET url = excluded.url
       RETURNING product_id`,
      [(json.product_name || 'Unknown').substring(0, 300), input, json.site || null]
    );
    await recordScrape(client, p.product_id, json);
    await client.query(
      `INSERT INTO tracking (user_id, product_id, target_price) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id) DO UPDATE SET target_price = excluded.target_price`,
      [req.user.user_id, p.product_id, target]
    );
    return p.product_id;
  });

  await runAlertChecks();
  // Searching other stores can take a minute; the product page shows results when ready
  compareProduct(productId).catch(err => console.error(`COMPARE ERROR (product ${productId}):`, err.message));

  const price = json.price;
  let message;
  if (typeof price !== 'number') message = "Tracking started, but the price couldn't be read yet — we'll keep trying.";
  else if (price <= target) message = `Good news: it's already ₹${price}, at or below your target of ₹${target}.`;
  else message = `Tracking started. Current price ₹${price}; we'll alert you at ₹${target} or less.`;

  res.json({ success: true, product_id: productId, price: price ?? null, message });
}));

// The user's tracked products with their latest price, last change and best other-store price
app.get('/api/products', auth.requireUser, api(async (req, res) => {
  const { rows } = await db.query(`
    SELECT p.product_id, p.name, p.url, p.site, p.currency, p.original_price, p.offer,
           p.last_checked_at, p.last_compared_at,
           t.target_price, t.created_at AS tracked_since,
           l.price, l.observed_at AS price_since,
           prev.price AS previous_price,
           s.lowest, s.highest, s.changes,
           c.site AS best_site, c.price AS best_price, c.url AS best_url
    FROM tracking t
    JOIN products p ON p.product_id = t.product_id
    LEFT JOIN latest_prices l ON l.product_id = p.product_id
    LEFT JOIN LATERAL (
      SELECT price FROM price_history WHERE product_id = p.product_id
      ORDER BY observed_at DESC, history_id DESC OFFSET 1 LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (
      SELECT min(price) AS lowest, max(price) AS highest, count(*) - 1 AS changes
      FROM price_history WHERE product_id = p.product_id
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT site, price, url FROM latest_competitor_prices
      WHERE product_id = p.product_id AND price IS NOT NULL AND match_type = 'exact'
      ORDER BY price LIMIT 1
    ) c ON true
    WHERE t.user_id = $1
    ORDER BY t.created_at DESC
  `, [req.user.user_id]);
  res.json({ products: rows, stale_days: STALE_DAYS });
}));

app.get('/api/products/:id', auth.requireUser, api(async (req, res) => {
  const product = await trackedProduct(req.user.user_id, req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const [history, competitors, competitorHistory] = await Promise.all([
    db.query(`SELECT price, original_price, observed_at FROM price_history
              WHERE product_id = $1 ORDER BY observed_at, history_id`, [product.product_id]),
    db.query(`SELECT site, title, url, price, checked_at, match_type, match_score, note FROM latest_competitor_prices
              WHERE product_id = $1 ORDER BY price NULLS LAST`, [product.product_id]),
    db.query(`SELECT site, price, checked_at FROM competitor_prices
              WHERE product_id = $1 AND price IS NOT NULL AND match_type = 'exact'
              ORDER BY checked_at DESC LIMIT 500`, [product.product_id]),
  ]);

  res.json({
    product,
    history: history.rows,
    competitors: competitors.rows,
    competitor_history: competitorHistory.rows.reverse(),
    stale_days: STALE_DAYS,
    comparing: busy.has(`compare:${product.product_id}`),
  });
}));

app.patch('/api/products/:id', auth.requireUser, api(async (req, res) => {
  const target = Number((req.body || {}).target_price);
  if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Enter a positive target price' });
  const { rowCount } = await db.query(
    `UPDATE tracking SET target_price = $3 WHERE user_id = $1 AND product_id = $2`,
    [req.user.user_id, req.params.id, target]);
  if (!rowCount) return res.status(404).json({ error: 'Product not found' });
  await runAlertChecks();
  res.json({ ok: true });
}));

app.delete('/api/products/:id', auth.requireUser, api(async (req, res) => {
  const { rowCount } = await db.query(
    `DELETE FROM tracking WHERE user_id = $1 AND product_id = $2`, [req.user.user_id, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
}));

app.post('/api/products/:id/refresh', auth.requireUser, api(async (req, res) => {
  const product = await trackedProduct(req.user.user_id, req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const json = await refreshProduct(product);
  if (json.busy) return res.status(409).json({ error: 'This product is already being checked' });
  await runAlertChecks();
  res.json({ success: json.success, price: json.price, message: json.message });
}));

app.post('/api/products/:id/compare', auth.requireUser, api(async (req, res) => {
  const product = await trackedProduct(req.user.user_id, req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const json = await compareProduct(product.product_id);
  if (json.busy) return res.status(409).json({ error: 'Other stores are already being checked for this product' });
  if (json.skipped) return res.status(422).json({ error: json.skipped });
  res.json({ success: true });
}));


// ---------- 🔔 NOTIFICATIONS ----------

app.get('/api/alerts', auth.requireUser, api(async (req, res) => {
  const { rows } = await db.query(`
    SELECT a.alert_id, a.product_id, a.kind, a.price, a.message, a.details, a.created_at, a.sent, a.read_at,
           a.sms_status, a.sms_error,
           p.name AS product_name
    FROM alerts a JOIN products p ON p.product_id = a.product_id
    WHERE a.user_id = $1
    ORDER BY a.created_at DESC, a.alert_id DESC
    LIMIT 50
  `, [req.user.user_id]);
  res.json({ alerts: rows, unread: rows.filter(a => !a.read_at).length });
}));

app.post('/api/alerts/read', auth.requireUser, api(async (req, res) => {
  await db.query(`UPDATE alerts SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user.user_id]);
  res.json({ ok: true });
}));


app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('ERROR:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});


// ---------- ⏰ BACKGROUND JOBS ----------

// 🔥 Alert check (price drops / stale prices / cheaper elsewhere) + SMS dispatch
let alertsRunning = false;
cron.schedule('*/2 * * * *', async () => {
  // Don't let a slow run overlap the next one
  if (alertsRunning) return;
  alertsRunning = true;
  try {
    await runAlertChecks();
  } catch (err) {
    console.error('ALERT CRON ERROR:', err);
  } finally {
    alertsRunning = false;
  }
});

// 🔄 Re-scrape every tracked product so history, graphs and stale alerts have data.
// One product at a time: each scrape may launch a headless Chrome.
let rescrapeRunning = false;
cron.schedule(RESCRAPE_CRON, async () => {
  if (rescrapeRunning) return;
  rescrapeRunning = true;
  console.log('⏳ Re-checking prices of tracked products...');
  try {
    const { rows } = await db.query(`
      SELECT p.product_id, p.url,
             p.last_compared_at IS NULL
               OR p.last_compared_at < now() - make_interval(hours => $1)
               -- a store refused or was unreachable last time: ask again (politely, once per run)
               OR EXISTS (SELECT 1 FROM latest_competitor_prices c
                          WHERE c.product_id = p.product_id
                            AND c.note ~ '(refused|couldn''t be reached)'
                            AND c.checked_at < now() - interval '1 hour') AS compare_due
      FROM products p
      WHERE EXISTS (SELECT 1 FROM tracking t WHERE t.product_id = p.product_id)
      ORDER BY p.last_checked_at NULLS FIRST
    `, [COMPARE_EVERY_HOURS]);

    for (const p of rows) {
      try {
        await refreshProduct(p);
        if (p.compare_due) await compareProduct(p.product_id);
      } catch (err) {
        console.error(`RESCRAPE ERROR (product ${p.product_id}):`, err.message);
      }
    }
    await runAlertChecks();
    console.log(`✅ Re-checked ${rows.length} product(s)`);
  } catch (err) {
    console.error('RESCRAPE CRON ERROR:', err);
  } finally {
    rescrapeRunning = false;
  }
});


db.init()
  .then(() => app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`)))
  .catch(err => {
    console.error('❌ Could not set up the PostgreSQL database:', err.message);
    console.error('   Set DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE) in .env');
    process.exit(1);
  });

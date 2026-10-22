// One-off import of the old SQLite database (database/sale_alert.db) into PostgreSQL.
//   npm run migrate:sqlite            (or: node scripts/migrate-sqlite.js path/to/file.db)
//
// Old users only had a phone number; they're imported without a login and are
// claimed — keeping their tracked products — when someone registers with that number.
// Safe to re-run: rows already present (same phone / url / tracking pair) are skipped.

require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../lib/db');

const file = process.argv[2] || path.join(__dirname, '..', 'database', 'sale_alert.db');
// SQLite's datetime('now') is UTC without a zone marker
const utc = ts => (ts ? `${ts.replace(' ', 'T')}Z` : null);

async function main() {
  const lite = new DatabaseSync(file, { readOnly: true });
  await db.init();

  const counts = await db.transaction(async client => {
    const userIds = new Map();
    const productIds = new Map();
    const n = { users: 0, products: 0, tracking: 0, price_history: 0, alerts: 0 };

    for (const u of lite.prepare(`SELECT * FROM users`).all()) {
      const phone = String(u.phone_number).replace(/[\s\-()]/g, '');
      let { rows: [row] } = await client.query(`SELECT user_id FROM users WHERE phone_number = $1 LIMIT 1`, [phone]);
      if (!row) {
        ({ rows: [row] } = await client.query(`INSERT INTO users (phone_number) VALUES ($1) RETURNING user_id`, [phone]));
        n.users++;
      }
      userIds.set(u.user_id, row.user_id);
    }

    for (const p of lite.prepare(`SELECT * FROM products`).all()) {
      const ins = await client.query(
        `INSERT INTO products (name, url) VALUES ($1, $2) ON CONFLICT (url) DO NOTHING RETURNING product_id`, [p.name, p.url]);
      n.products += ins.rowCount;
      const { rows: [row] } = await client.query(`SELECT product_id FROM products WHERE url = $1`, [p.url]);
      productIds.set(p.product_id, { id: row.product_id, isNew: ins.rowCount > 0 });
    }

    for (const t of lite.prepare(`SELECT * FROM tracking`).all()) {
      const ins = await client.query(
        `INSERT INTO tracking (user_id, product_id, target_price) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, product_id) DO NOTHING`,
        [userIds.get(t.user_id), productIds.get(t.product_id).id, t.target_price]);
      n.tracking += ins.rowCount;
    }

    // Postgres keeps one row per price change, so drop consecutive repeats.
    // History is only copied for products this run created, so re-runs don't duplicate it.
    let last = new Map();
    for (const h of lite.prepare(`SELECT * FROM price_history ORDER BY product_id, timestamp, history_id`).all()) {
      const p = productIds.get(h.product_id);
      if (!p.isNew || !(h.price > 0) || last.get(h.product_id) === h.price) continue;
      last.set(h.product_id, h.price);
      await client.query(
        `INSERT INTO price_history (product_id, price, observed_at) VALUES ($1, $2, $3)`, [p.id, h.price, utc(h.timestamp)]);
      await client.query(
        `UPDATE products SET last_checked_at = GREATEST(last_checked_at, $2) WHERE product_id = $1`, [p.id, utc(h.timestamp)]);
      n.price_history++;
    }

    for (const a of lite.prepare(`SELECT * FROM alerts`).all()) {
      const p = productIds.get(a.product_id);
      if (!p.isNew) continue;
      await client.query(
        `INSERT INTO alerts (user_id, product_id, kind, price, created_at, sent, read_at)
         VALUES ($1, $2, 'price_drop', $3, $4, $5, now())`,
        [userIds.get(a.user_id), p.id, a.price, utc(a.created_at), !!a.sent]);
      n.alerts++;
    }
    return n;
  });

  console.log('✅ Imported:', counts);
  await db.pool.end();
}

main().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});

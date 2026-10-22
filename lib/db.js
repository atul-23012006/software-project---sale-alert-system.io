const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// NUMERIC comes back as a string by default (to avoid precision loss); prices
// are NUMERIC(12,2), well within a JS number's precision, so parse them.
types.setTypeParser(types.builtins.NUMERIC, v => (v === null ? null : parseFloat(v)));
// Same for BIGINT ids and count(*): they stay far below Number.MAX_SAFE_INTEGER
types.setTypeParser(types.builtins.INT8, v => (v === null ? null : parseInt(v, 10)));

// DATABASE_URL (postgres://user:pass@host:5432/db), or the standard PGHOST /
// PGUSER / PGPASSWORD / PGDATABASE / PGPORT variables when it isn't set.
const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});

pool.on('error', err => console.error('PG POOL ERROR:', err.message));

async function init() {
  for (const file of ['schema.sql', 'procedures.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', file), 'utf8'));
  }
}

// Runs fn(client) inside BEGIN/COMMIT, rolling back if it throws.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), init, transaction };

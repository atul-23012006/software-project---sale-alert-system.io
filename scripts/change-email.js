// Changes the email on an existing account (e.g. swapping a typo'd or fake
// address for a real inbox so alerts actually arrive).
//   npm run change-email -- old@example.com new@example.com
//
// Run it on the machine that hosts the database: anyone who can run it can already
// read the database, so it grants no extra power.

require('dotenv').config({ quiet: true });
const db = require('../lib/db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main() {
  const oldEmail = (process.argv[2] || '').trim().toLowerCase();
  const newEmail = (process.argv[3] || '').trim().toLowerCase();
  if (!oldEmail || !newEmail) {
    console.error('Usage: npm run change-email -- old@example.com new@example.com');
    process.exit(1);
  }
  if (!EMAIL_RE.test(newEmail)) {
    console.error(`"${newEmail}" doesn't look like a valid email address.`);
    process.exit(1);
  }

  const { rows: [user] } = await db.query(`SELECT user_id, name FROM users WHERE email = $1`, [oldEmail]);
  if (!user) {
    console.error(`No account with the email ${oldEmail}.`);
    process.exit(1);
  }

  const { rows: [taken] } = await db.query(`SELECT 1 FROM users WHERE email = $1`, [newEmail]);
  if (taken) {
    console.error(`${newEmail} is already in use by another account.`);
    process.exit(1);
  }

  await db.query(`UPDATE users SET email = $2 WHERE user_id = $1`, [user.user_id, newEmail]);

  console.log(`✅ Email changed from ${oldEmail} to ${newEmail}${user.name ? ` for ${user.name}` : ''}.`);
  console.log('   Existing login sessions are unaffected; log in with the new email from now on.');
  await db.pool.end();
}

main().catch(err => {
  console.error('❌ Could not change the email:', err.message);
  process.exit(1);
});

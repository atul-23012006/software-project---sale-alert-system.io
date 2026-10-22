// Sets a new password for an account, for when its owner has forgotten it.
//   npm run reset-password -- you@example.com
//
// Run it on the machine that hosts the database: anyone who can run it can already
// read the database, so it grants no extra power. The new password is typed at a hidden
// prompt (never on the command line, where it would land in shell history), and every
// existing login session for the account is ended.

require('dotenv').config({ quiet: true });
const db = require('../lib/db');
const auth = require('../lib/auth');

// Reads one line from the terminal without echoing it
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('Run this in a terminal so the password can be typed privately'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = ch => {
      if (ch === '\u0003') { // Ctrl+C
        stdin.setRawMode(false);
        stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        return resolve(input);
      }
      if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1); // Backspace
      else input += ch;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run reset-password -- you@example.com');
    process.exit(1);
  }

  const { rows: [user] } = await db.query(`SELECT user_id, name FROM users WHERE email = $1`, [email]);
  if (!user) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }

  const password = await promptHidden(`New password for ${email}: `);
  if (password.length < 8) {
    console.error('Password must be at least 8 characters. Nothing was changed.');
    process.exit(1);
  }
  if ((await promptHidden('Type it again: ')) !== password) {
    console.error("The two passwords don't match. Nothing was changed.");
    process.exit(1);
  }

  await db.transaction(async client => {
    await client.query(`UPDATE users SET password_hash = $2 WHERE user_id = $1`,
      [user.user_id, await auth.hashPassword(password)]);
    // Anyone still logged in with the old password is signed out
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [user.user_id]);
  });

  console.log(`✅ Password changed for ${email}. Log in at http://localhost:3000/login.html`);
  await db.pool.end();
}

main().catch(err => {
  console.error('❌ Could not reset the password:', err.message);
  process.exit(1);
});

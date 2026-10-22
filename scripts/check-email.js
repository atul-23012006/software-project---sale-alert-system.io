// Tests the SMTP settings in .env by logging in to the mail server, without sending anything.
//   npm run check-email
require('dotenv').config({ quiet: true });
const { verify } = require('../lib/mailer');

verify()
  .then(() => console.log('✅ SMTP settings work: logged in to the mail server. Password-reset emails can be sent.'))
  .catch(err => {
    console.error('❌ SMTP check failed:', err.message);
    console.error('   Check SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in .env (for Gmail, SMTP_PASS must be an App Password).');
    process.exit(1);
  });

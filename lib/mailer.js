const nodemailer = require('nodemailer');

// SMTP is optional: without it, "Forgot password?" says email isn't set up and points
// to `npm run reset-password`. Settings (in .env):
//   SMTP_HOST, SMTP_PORT (587 = STARTTLS, 465 = TLS), SMTP_USER, SMTP_PASS, SMTP_FROM,
//   SMTP_SECURE=true for a server that uses TLS from the start on a port other than 465
const port = Number(process.env.SMTP_PORT) || 587;
const secure = process.env.SMTP_SECURE === 'true' || port === 465;
const transporter = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      requireTLS: !secure,   // never send the password-reset link unencrypted
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;
if (!transporter) console.warn("⚠️  SMTP settings missing — password-reset emails are disabled");

const FROM = process.env.SMTP_FROM || process.env.SMTP_USER;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendPasswordReset({ to, name, link, minutes }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  await transporter.sendMail({
    from: `"Sale Alert System" <${FROM}>`,
    to,
    subject: 'Reset your Sale Alert password',
    text: `${hello}

Someone (hopefully you) asked to reset the password for your Sale Alert account.
Open this link to choose a new password:

${link}

The link works once and expires in ${minutes} minutes.
If you didn't ask for this, ignore this email — your password won't change.`,
    html: `<p>${escapeHtml(hello)}</p>
<p>Someone (hopefully you) asked to reset the password for your Sale Alert account.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#2f7ff0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(link)}</p>
<p style="color:#666;font-size:13px">The link works once and expires in ${minutes} minutes. If you didn't ask for this, ignore this email — your password won't change.</p>`,
  });
}

const STORE_NAMES = {
  amazon: 'Amazon.in', shopclues: 'ShopClues', reliancedigital: 'Reliance Digital', tatacliq: 'Tata CLiQ', jiomart: 'JioMart', vijaysales: 'Vijay Sales',
};
const storeName = s => STORE_NAMES[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'another store');

function priceAlertCopy({ kind, name, price, url, details }) {
  const money = v => `₹${v}`;
  if (kind === 'no_change') {
    return {
      subject: `Still ${money(price)}: ${name}`,
      lead: `No change yet — <strong>${escapeHtml(name)}</strong> has stayed at ${money(price)} for ${details.days} days.`,
    };
  }
  if (kind === 'cheaper_elsewhere') {
    return {
      subject: `Cheaper on ${storeName(details.site)}: ${name}`,
      lead: `<strong>${escapeHtml(name)}</strong> is ${money(details.current_price)} where you're tracking it, but ${money(price)} on ${escapeHtml(storeName(details.site))}.`,
      url: details.url || url,
    };
  }
  return {
    subject: `Price drop! ${name} is now ${money(price)}`,
    lead: `Good news — <strong>${escapeHtml(name)}</strong> just dropped to ${money(price)}, at or below your target.`,
  };
}

async function sendPriceAlert({ to, name, price, url, kind, details }) {
  const { subject, lead, url: linkOverride } = priceAlertCopy({ kind, name, price, url, details });
  const link = linkOverride || url;
  await transporter.sendMail({
    from: `"Sale Alert System" <${FROM}>`,
    to,
    subject,
    text: `${subject}\n\n${link}`,
    html: `<p>${lead}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#2f7ff0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">View product</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(link)}</p>`,
  });
}

// Checks the SMTP settings by logging in to the server, without sending anything
const verify = () => (transporter ? transporter.verify() : Promise.reject(new Error('SMTP is not configured')));

module.exports = { sendPasswordReset, sendPriceAlert, verify, mailEnabled: !!transporter };

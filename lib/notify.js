const twilio = require('twilio');
const db = require('./db');
const mailer = require('./mailer');

// Twilio is optional: without credentials the app still tracks prices and
// shows alerts in-app, it just can't text
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
if (!twilioClient) console.warn("⚠️  Twilio credentials missing — SMS alerts are disabled");


// Short, plain-ASCII SMS. Emoji / ₹ force Unicode encoding (70 chars per SMS instead
// of 160), and Twilio trial accounts prepend ~38 chars, so keep the body to ~120 chars.
const SMS_MAX = 120;

function shortUrl(u) {
  const m = u.match(/(amazon\.[a-z.]+)\/(?:.*\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (m) return `${m[1]}/dp/${m[2]}`;
  return u.split('?')[0].replace(/^(https?:\/\/)?(www\.)?/, '');
}

function shortName(name) {
  name = (name || '').replace(/[^\x20-\x7E]/g, '').trim() || 'Product';
  return name.length > 30 ? name.substring(0, 27).trimEnd() + '...' : name;
}

const STORE_NAMES = {
  amazon: 'Amazon.in', shopclues: 'ShopClues', reliancedigital: 'Reliance Digital', tatacliq: 'Tata CLiQ', jiomart: 'JioMart', vijaysales: 'Vijay Sales',
};
const storeName = s => STORE_NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);

function buildSms({ kind, name, price, url, details }) {
  const n = shortName(name);
  const money = v => `Rs.${v}`;
  let text, link;
  if (kind === 'no_change') {
    text = `No change: ${n} still ${money(price)} after ${details.days} days`;
  } else if (kind === 'cheaper_elsewhere') {
    text = `Cheaper on ${storeName(details.site)}: ${n} ${money(price)} (vs ${money(details.current_price)})`;
    link = details.url;
  } else {
    text = `Price drop! ${n} now ${money(price)}`;
    link = url;
  }
  link = shortUrl(link || '');
  // Drop the link rather than split into a second SMS
  return link && text.length + 1 + link.length <= SMS_MAX ? `${text} ${link}` : text;
}


let dispatching = false;

// Texts queued alerts. Only recent ones, so a user who adds a phone number
// later isn't flooded with old news.
async function dispatchAlerts() {
  if (!twilioClient || dispatching) return;
  dispatching = true;
  try {
    const { rows } = await db.query(`
      SELECT a.alert_id, a.kind, a.price, a.details, u.phone_number, p.name, p.url
      FROM alerts a
      JOIN users u    ON u.user_id = a.user_id
      JOIN products p ON p.product_id = a.product_id
      WHERE NOT a.sent
        AND u.phone_number IS NOT NULL
        AND a.created_at > now() - interval '1 day'
      ORDER BY a.alert_id
    `);

    for (const row of rows) {
      try {
        const msg = await twilioClient.messages.create({
          body: buildSms(row),
          from: process.env.TWILIO_FROM_NUMBER,
          to: row.phone_number
        });
        // "Accepted" isn't "delivered": refreshDeliveryStatus() follows it up
        await db.query(`UPDATE alerts SET sent = true, sms_sid = $2, sms_status = $3 WHERE alert_id = $1`,
          [row.alert_id, msg.sid, msg.status]);
      } catch (err) {
        console.error(`SMS ERROR (alert ${row.alert_id}):`, err.message);
        // Twilio refused it outright (invalid number, unverified number on a trial account, ...):
        // retrying every 2 minutes won't help, so record why and stop
        if (err.status && err.status >= 400 && err.status < 500) {
          await db.query(`UPDATE alerts SET sent = true, sms_status = 'failed', sms_error = $2 WHERE alert_id = $1`,
            [row.alert_id, smsErrorText(err.code, err.message)]);
        }
      }
    }
  } finally {
    dispatching = false;
  }
}


// Plain-language reasons for the Twilio errors users actually hit
// (https://www.twilio.com/docs/api/errors)
const SMS_ERRORS = {
  21211: "the phone number isn't valid",
  21408: 'SMS to this country is not enabled on the Twilio account',
  21608: 'Twilio trial accounts can only text verified numbers — verify this number in the Twilio console',
  21610: 'this number has opted out of messages (replied STOP)',
  21614: "this number can't receive SMS",
  30003: 'the phone was unreachable (switched off or out of coverage)',
  30005: "the number doesn't exist",
  30006: "the number can't receive SMS (landline or unreachable carrier)",
  30007: 'the carrier filtered the message as spam',
  30008: 'the carrier reported an unknown error',
  30032: 'the Twilio sender number is not set up to text this country',
  30034: 'the message was blocked: Indian carriers need the sender registered on DLT',
};
const smsErrorText = (code, fallback) =>
  SMS_ERRORS[code] || (code ? `Twilio error ${code}${fallback ? `: ${fallback}` : ''}` : fallback || 'unknown error');

let dispatchingEmail = false;

// Emails queued alerts, same cutoff and "only once" semantics as dispatchAlerts(),
// but tracked in email_sent/email_error since a user may have an email, a phone
// number, or both, and each channel should retry/fail independently.
async function dispatchEmailAlerts() {
  if (!mailer.mailEnabled || dispatchingEmail) return;
  dispatchingEmail = true;
  try {
    const { rows } = await db.query(`
      SELECT a.alert_id, a.kind, a.price, a.details, u.email, u.name, p.name AS product_name, p.url
      FROM alerts a
      JOIN users u    ON u.user_id = a.user_id
      JOIN products p ON p.product_id = a.product_id
      WHERE NOT a.email_sent
        AND u.email IS NOT NULL
        AND a.created_at > now() - interval '1 day'
      ORDER BY a.alert_id
    `);

    for (const row of rows) {
      try {
        await mailer.sendPriceAlert({
          to: row.email, name: row.product_name, price: row.price, url: row.url,
          kind: row.kind, details: row.details,
        });
        await db.query(`UPDATE alerts SET email_sent = true WHERE alert_id = $1`, [row.alert_id]);
      } catch (err) {
        console.error(`EMAIL ALERT ERROR (alert ${row.alert_id}):`, err.message);
        // Leave email_sent false: SMTP errors here (bad auth, server down, ...) are usually
        // config problems, not "this address bounced", so retry next run rather than giving up.
        await db.query(`UPDATE alerts SET email_error = $2 WHERE alert_id = $1`,
          [row.alert_id, err.message]);
      }
    }
  } finally {
    dispatchingEmail = false;
  }
}

let refreshing = false;

// Asks Twilio what happened to recently sent messages (delivered, or why not)
async function refreshDeliveryStatus() {
  if (!twilioClient || refreshing) return;
  refreshing = true;
  try {
    const { rows } = await db.query(`
      SELECT alert_id, sms_sid FROM alerts
      WHERE sms_sid IS NOT NULL
        AND sms_status IN ('queued', 'accepted', 'scheduled', 'sending', 'sent')
        AND created_at > now() - interval '1 day'
    `);
    for (const row of rows) {
      try {
        const msg = await twilioClient.messages(row.sms_sid).fetch();
        const failed = msg.status === 'failed' || msg.status === 'undelivered';
        await db.query(`UPDATE alerts SET sms_status = $2, sms_error = $3 WHERE alert_id = $1`,
          [row.alert_id, msg.status, failed ? smsErrorText(msg.errorCode, msg.errorMessage) : null]);
        if (failed) console.error(`SMS NOT DELIVERED (alert ${row.alert_id}): ${smsErrorText(msg.errorCode, msg.errorMessage)}`);
      } catch (err) {
        console.error(`SMS STATUS ERROR (alert ${row.alert_id}):`, err.message);
      }
    }
  } finally {
    refreshing = false;
  }
}

module.exports = { dispatchAlerts, dispatchEmailAlerts, refreshDeliveryStatus, buildSms, smsEnabled: !!twilioClient };

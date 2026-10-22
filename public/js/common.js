// Shared helpers for the logged-in pages: API calls, formatting, the top bar.

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Please log in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
// Every supported store is Indian, so prices are always rupees
function money(value) {
  if (value === null || value === undefined) return '—';
  return inr.format(value);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DAY = 86400000;
function daysSince(iso) {
  return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null;
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function formatDate(iso, withTime = true) {
  return new Date(iso).toLocaleString('en-IN', withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

const SITE_NAMES = {
  amazon: 'Amazon.in', snapdeal: 'Snapdeal', shopclues: 'ShopClues', flipkart: 'Flipkart',
  reliancedigital: 'Reliance Digital', tatacliq: 'Tata CLiQ', jiomart: 'JioMart', vijaysales: 'Vijay Sales', unknown: 'Store',
};
// A store missing from the list shows its own name ("Myntra"), never a vague "Store"
const siteName = s => SITE_NAMES[s] || (s && s !== 'unknown' ? s.charAt(0).toUpperCase() + s.slice(1) : SITE_NAMES.unknown);
const sitePill = s => `<span class="site-pill ${escapeHtml(s || '')}">${escapeHtml(siteName(s))}</span>`;

// Discount vs MRP, e.g. 71 for ₹1,299 against ₹4,490
function discountPct(price, original) {
  return price && original && original > price ? Math.round((1 - price / original) * 100) : null;
}

const ALERT_ICONS = { price_drop: '📉', no_change: '⏸️', cheaper_elsewhere: '🏷️' };

// What happened to the SMS, as Twilio reports it
function smsNote(a) {
  if (a.sms_status === 'delivered') return ' · <span class="down">✓ SMS delivered</span>';
  if (a.sms_status === 'failed' || a.sms_status === 'undelivered') {
    return ` · <span class="up">✗ SMS not delivered: ${escapeHtml(a.sms_error || 'unknown reason')}</span>`;
  }
  if (a.sms_status) return ' · SMS sent (waiting for delivery report)';
  return a.sent ? ' · sent by SMS' : '';
}

function renderAlerts(listEl, alerts) {
  if (!alerts.length) {
    listEl.innerHTML = '<li class="empty">No notifications yet. You\'ll see price drops, unchanged prices and cheaper offers here.</li>';
    return;
  }
  listEl.innerHTML = alerts.map(a => `
    <li class="alert-item ${a.read_at ? '' : 'unread'}">
      <div class="icon" aria-hidden="true">${ALERT_ICONS[a.kind] || '🔔'}</div>
      <div>
        <a href="/product.html?id=${a.product_id}">${escapeHtml(a.message)}</a>
        <div class="when">${timeAgo(a.created_at)}${smsNote(a)}</div>
      </div>
    </li>`).join('');
}

// Top bar with nav, unread badge and logout. Resolves to the current user.
async function initTopbar(active) {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <a class="brand" href="/history.html">
      <span class="logo" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 8h12M6 12h12M6 16h8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg></span>
      Sale Alert
    </a>
    <nav>
      <a href="/history.html" data-page="dashboard">Dashboard <span class="badge-count" id="unreadBadge" hidden></span></a>
      <a href="/index.html" data-page="track">Track a product</a>
    </nav>
    <div class="user"><span class="who" id="whoami"></span><button class="btn ghost small" id="logoutBtn" type="button">Log out</button></div>`;
  document.body.prepend(bar);
  bar.querySelector(`[data-page="${active}"]`)?.classList.add('active');
  bar.querySelector('#logoutBtn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login.html';
  };

  const [{ user, sms_enabled }, { unread }] = await Promise.all([api('/api/auth/me'), api('/api/alerts')]);
  bar.querySelector('#whoami').textContent = user.name || user.email;
  const badge = bar.querySelector('#unreadBadge');
  if (unread) { badge.textContent = unread; badge.hidden = false; }
  return { user, sms_enabled };
}

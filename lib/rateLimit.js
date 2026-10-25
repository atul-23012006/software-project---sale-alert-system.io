// Tiny in-memory fixed-window rate limiter (per process; resets on restart).
// rateLimit({ windowMs, max, key }) -> Express middleware answering 429 once `key(req)` has
// made more than `max` requests inside the window. Default key is the client IP.
const buckets = new Map(); // "name:key" -> { count, resetAt }

function rateLimit({ name, windowMs, max, key = req => req.ip, message = 'Too many requests — please try again later' }) {
  return (req, res, next) => {
    const id = `${name}:${key(req)}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(id, b);
    }
    if (++b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// Drop expired windows so the map can't grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of buckets) if (b.resetAt <= now) buckets.delete(id);
}, 60 * 1000).unref();

module.exports = rateLimit;

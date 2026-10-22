-- PostgreSQL schema. Applied automatically by server.js on startup (idempotent).

CREATE TABLE IF NOT EXISTS users (
    user_id       BIGSERIAL PRIMARY KEY,
    name          TEXT,
    email         TEXT UNIQUE,              -- stored lower-cased
    password_hash TEXT,                     -- NULL = legacy phone-only user, claimable on registration
    phone_number  TEXT,                     -- +91 + 10-digit mobile, optional; needed only for SMS
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One person may have several accounts on one phone, so the number isn't unique
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_number_key;
CREATE INDEX IF NOT EXISTS users_phone_idx ON users (phone_number);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,            -- sha256 of the cookie value; the raw token is never stored
    user_id    BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- "Forgot password" links: one-time, short-lived; only the token's hash is stored
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
    product_id       BIGSERIAL PRIMARY KEY,
    name             TEXT,
    url              TEXT NOT NULL UNIQUE,
    site             TEXT,                  -- amazon / flipkart / myntra / ... (see SITES in webscrape.py)
    currency         TEXT,                  -- always INR: only Indian stores are supported
    original_price   NUMERIC(12,2),         -- current MRP / list price, when the page shows one
    offer            TEXT,                  -- current deal badge / discount text
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at  TIMESTAMPTZ,           -- last scrape that returned a price
    last_compared_at TIMESTAMPTZ            -- last search of the other stores
);

CREATE TABLE IF NOT EXISTS tracking (
    tracking_id  BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    product_id   BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    target_price NUMERIC(12,2) NOT NULL CHECK (target_price > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, product_id)
);

-- One row per price CHANGE (not per check): products.last_checked_at says when
-- it was last confirmed, so "unchanged since" is simply the latest row's observed_at.
CREATE TABLE IF NOT EXISTS price_history (
    history_id     BIGSERIAL PRIMARY KEY,
    product_id     BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    price          NUMERIC(12,2) NOT NULL CHECK (price > 0),
    original_price NUMERIC(12,2),
    observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_history_product_idx ON price_history (product_id, observed_at DESC);

-- Every search of another store; price NULL = nothing found there.
-- match_type 'exact' = the same product; 'similar' = the store doesn't sell it, so this
-- is the closest product it does sell (shown to the user, never used for alerts).
CREATE TABLE IF NOT EXISTS competitor_prices (
    id         BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    site       TEXT NOT NULL,
    title      TEXT,
    url        TEXT,
    price      NUMERIC(12,2),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE competitor_prices ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'exact'
    CHECK (match_type IN ('exact', 'similar'));
ALTER TABLE competitor_prices ADD COLUMN IF NOT EXISTS match_score NUMERIC(3,2);
-- Why there's no listing (price NULL): "nothing similar found", "the store refused the automated search", ...
ALTER TABLE competitor_prices ADD COLUMN IF NOT EXISTS note TEXT;
CREATE INDEX IF NOT EXISTS competitor_prices_product_idx ON competitor_prices (product_id, site, checked_at DESC);

-- Doubles as the SMS queue (sent) and the in-app notification list (read_at).
CREATE TABLE IF NOT EXISTS alerts (
    alert_id   BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'price_drop'
               CHECK (kind IN ('price_drop', 'no_change', 'cheaper_elsewhere')),
    price      NUMERIC(12,2),
    message    TEXT,
    details    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent       BOOLEAN NOT NULL DEFAULT false,
    read_at    TIMESTAMPTZ
);
-- SMS delivery as Twilio reports it: queued -> sent -> delivered, or failed/undelivered
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS sms_sid TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS sms_status TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS sms_error TEXT;
-- Email delivery, tracked separately from sms_* because a user may have only
-- an email, only a phone number, or both.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS email_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS email_error TEXT;
CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts (user_id, created_at DESC);

CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (product_id) product_id, price, original_price, observed_at
FROM price_history
ORDER BY product_id, observed_at DESC, history_id DESC;

CREATE OR REPLACE VIEW latest_competitor_prices AS
SELECT DISTINCT ON (product_id, site) product_id, site, title, url, price, checked_at, match_type, match_score, note
FROM competitor_prices
ORDER BY product_id, site, checked_at DESC, id DESC;

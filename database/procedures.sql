-- PL/pgSQL alert procedures. Applied automatically by server.js on startup (after schema.sql).
-- Each queues rows in `alerts`; server.js texts the unsent ones and shows all of them in-app.
-- Each returns the number of alerts it queued.


-- Product names from store pages can be 200 characters; keep alert text readable.
CREATE OR REPLACE FUNCTION short_name(name text) RETURNS text AS $$
    SELECT CASE
        WHEN name IS NULL OR name = '' THEN 'Your product'
        WHEN length(name) > 60 THEN rtrim(left(name, 57)) || '...'
        ELSE name
    END;
$$ LANGUAGE sql IMMUTABLE;


-- 'Rs.1299' — plain ASCII so the text also fits a single SMS
CREATE OR REPLACE FUNCTION money_text(amount numeric) RETURNS text AS $$
    SELECT 'Rs.' || trim_scale(amount)::text;
$$ LANGUAGE sql IMMUTABLE;


CREATE OR REPLACE FUNCTION store_name(site text) RETURNS text AS $$
    SELECT CASE site
        WHEN 'amazon' THEN 'Amazon.in'
        WHEN 'shopclues' THEN 'ShopClues'
        WHEN 'reliancedigital' THEN 'Reliance Digital'
        WHEN 'tatacliq' THEN 'Tata CLiQ'
        WHEN 'jiomart' THEN 'JioMart'
        WHEN 'vijaysales' THEN 'Vijay Sales'
        ELSE initcap(site)
    END;
$$ LANGUAGE sql IMMUTABLE;


-- Price at/below the user's target. Once per price change, so an unchanged
-- low price doesn't re-alert on every check.
CREATE OR REPLACE FUNCTION check_alerts() RETURNS integer AS $$
DECLARE
    n integer;
BEGIN
    INSERT INTO alerts (user_id, product_id, kind, price, message)
    SELECT t.user_id, t.product_id, 'price_drop', l.price,
           format('Price drop! %s is now %s (your target: %s).',
                  short_name(p.name), money_text(l.price), money_text(t.target_price))
    FROM tracking t
    JOIN products p      ON p.product_id = t.product_id
    JOIN latest_prices l ON l.product_id = t.product_id
    WHERE l.price <= t.target_price
      AND NOT EXISTS (
          SELECT 1 FROM alerts a
          WHERE a.user_id = t.user_id
            AND a.product_id = t.product_id
            AND a.kind = 'price_drop'
            AND a.created_at >= l.observed_at
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;


-- Price hasn't moved for `stale_days`. Only while the product is still being
-- checked successfully (otherwise "no change" may just mean "scraper broken"),
-- and at most once every `stale_days` per user/product.
CREATE OR REPLACE FUNCTION check_stale_prices(stale_days integer) RETURNS integer AS $$
DECLARE
    n integer;
BEGIN
    INSERT INTO alerts (user_id, product_id, kind, price, message, details)
    SELECT t.user_id, t.product_id, 'no_change', l.price,
           format('No change: %s has stayed at %s for %s days.',
                  short_name(p.name), money_text(l.price), d.days),
           jsonb_build_object('days', d.days)
    FROM tracking t
    JOIN products p      ON p.product_id = t.product_id
    JOIN latest_prices l ON l.product_id = t.product_id
    CROSS JOIN LATERAL (
        SELECT floor(extract(epoch FROM now() - l.observed_at) / 86400)::int AS days
    ) d
    WHERE d.days >= stale_days
      AND p.last_checked_at > now() - interval '2 days'
      AND NOT EXISTS (
          SELECT 1 FROM alerts a
          WHERE a.user_id = t.user_id
            AND a.product_id = t.product_id
            AND a.kind = 'no_change'
            AND a.created_at > greatest(l.observed_at, now() - make_interval(days => stale_days))
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;


-- Another store's latest price for the SAME product (checked within a day) beats the tracked store's.
-- Not repeated for the same store + price within a week.
CREATE OR REPLACE FUNCTION check_cheaper_elsewhere() RETURNS integer AS $$
DECLARE
    n integer;
BEGIN
    INSERT INTO alerts (user_id, product_id, kind, price, message, details)
    SELECT t.user_id, t.product_id, 'cheaper_elsewhere', c.price,
           format('Cheaper elsewhere: %s is %s on %s (vs %s where you track it).',
                  short_name(p.name), money_text(c.price), store_name(c.site), money_text(l.price)),
           jsonb_build_object('site', c.site, 'url', c.url, 'current_price', l.price)
    FROM tracking t
    JOIN products p      ON p.product_id = t.product_id
    JOIN latest_prices l ON l.product_id = t.product_id
    JOIN LATERAL (
        SELECT site, url, price, checked_at
        FROM latest_competitor_prices c
        WHERE c.product_id = t.product_id AND c.price IS NOT NULL AND c.match_type = 'exact'
        ORDER BY c.price
        LIMIT 1
    ) c ON true
    WHERE c.price < l.price
      AND c.checked_at > now() - interval '1 day'
      AND NOT EXISTS (
          SELECT 1 FROM alerts a
          WHERE a.user_id = t.user_id
            AND a.product_id = t.product_id
            AND a.kind = 'cheaper_elsewhere'
            AND a.price = c.price
            AND a.details->>'site' = c.site
            AND a.created_at > now() - interval '7 days'
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;

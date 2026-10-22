-- Drops every Sale Alert System object. All data is lost.
--   psql "$DATABASE_URL" -f database/cleanup.sql

DROP VIEW IF EXISTS latest_competitor_prices, latest_prices;
DROP FUNCTION IF EXISTS check_alerts(), check_stale_prices(integer), check_cheaper_elsewhere(), short_name(text), money_text(numeric), store_name(text);
DROP TABLE IF EXISTS alerts, competitor_prices, price_history, tracking, products, sessions, users CASCADE;

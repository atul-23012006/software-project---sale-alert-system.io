# Sale Alert System

A price tracker for Indian e-commerce stores: Amazon.in, Flipkart, Snapdeal, ShopClues, Reliance Digital, Tata CLiQ, JioMart and Vijay Sales. Users create an account, paste a product link and a target price, and the system:

- **records the price history** of every product, keeping one row per price change, and plots it on a graph;
- **re-checks prices in the background** (every 6 hours by default);
- **alerts the user** (in-app, and by SMS through Twilio when a phone number is set) when:
  - the price drops to or below their target,
  - the price **hasn't changed for a long time** (7 days by default),
  - the product is **cheaper on another store**;
- **searches other stores** (Amazon.in, Snapdeal, ShopClues) for the same product and shows what they charge;
- shows **sale offers**: MRP, discount %, deal badges, and how the current price compares with the lowest and highest prices on record.

It's built with a **Node.js / Express** server, a **Python scraper** (requests + BeautifulSoup, with a headless Selenium fallback) and a **PostgreSQL** database.

---

## Architecture

```mermaid
graph TD
    subgraph Browser
        L[login.html / register.html]
        A[index.html: track a product]
        B[history.html: dashboard + notifications]
        P[product.html: graph, history, other stores, offers]
    end

    subgraph Server [Node.js / Express]
        AUTH[/api/auth/*/]
        API[/api/track, /api/products/*, /api/alerts/]
        C1[cron every 2 min: alert checks + SMS]
        C2[cron every 6 h: re-scrape + compare]
    end

    subgraph Scraper [webscrape.py]
        S1[scrape: price, name, MRP, offer]
        S2[compare: search other stores]
    end

    DB[(PostgreSQL: tables + PL/pgSQL alert functions)]
    TW[Twilio SMS]

    L --> AUTH --> DB
    A & B & P --> API
    API --> S1 & S2
    C2 --> S1 & S2
    API --> DB
    C1 -->|check_alerts / check_stale_prices / check_cheaper_elsewhere| DB
    C1 --> TW
```

### How the data flows

1. **Track**: `POST /api/track` runs `webscrape.py scrape <url>`, which reads the price, name, MRP and offer text. JSON-LD structured data is tried first, then CSS selectors, then a headless Chrome render. The product, a `price_history` row and the user's `tracking` row are saved in one transaction.
2. **Compare**: the server then runs `webscrape.py compare "<product name>" <own site>` in the background. It searches the other stores and keeps the closest-matching listing from each. A listing only counts as a match if it:
   - contains the first three words of the name (brand and model);
   - contains every model or size number (e.g. "iPhone **15** **128** GB");
   - isn't a multi-pack or a different gender's version;
   - shares at least 60% of the name's words.

   If a store doesn't sell the product, its **closest similar product** is recorded instead, marked `similar`. To find it, the scraper:
   - picks the best word overlap, with the brand counting triple (so the same brand wins over lookalikes);
   - retries once with just the brand and product line if the results are weak;
   - never picks accessories or multi-packs;
   - only accepts prices between ¼ and 4 times the tracked price, so a phone case can't stand in for a phone.

   Similar products are shown in the "Other stores" table with their price, but they never trigger alerts and aren't plotted on the graph. If a store refuses a search (for example Amazon throttling with HTTP 503), the reason is shown, its last real result is kept, and it is asked again at the next background run. Results go into `competitor_prices`.
3. **Re-check**: every `RESCRAPE_CRON` interval each tracked product is scraped again. A new `price_history` row is written **only when the price changes**; `products.last_checked_at` records that the price was confirmed. Other stores are re-searched every `COMPARE_EVERY_HOURS`.
4. **Alert**: every 2 minutes the PL/pgSQL functions in `database/procedures.sql` queue alerts, and the server texts any that haven't been sent:

   | Function | Fires when | Repeats |
   | --- | --- | --- |
   | `check_alerts()` | latest price ≤ target | once per price change |
   | `check_stale_prices(days)` | price unchanged for `STALE_DAYS`, while checks are still succeeding | at most once every `STALE_DAYS` |
   | `check_cheaper_elsewhere()` | another store's price for the **same** product (not a similar one), checked within the last day, is lower | not for the same store + price within 7 days |

### Supported stores

| Store | Track a product link | Searched when comparing |
| --- | --- | --- |
| Amazon.in, Snapdeal, ShopClues | ✅ | ✅ |
| Flipkart, Reliance Digital, Tata CLiQ | ✅ | ❌ their robots.txt disallows search pages |
| JioMart, Vijay Sales | ✅ | ❌ search results need a location/session |
| Myntra, Ajio, Nykaa, Croma, Meesho | ❌ they refuse automated requests (Myntra silently ignores clients that identify as bots) | ❌ |
| Non-Indian stores (eBay, amazon.com, …) | ❌ not supported | ❌ |

### Scraping rules

The scraper only reads publicly visible prices, and plays by each store's rules:

- **It identifies itself honestly** as `SaleAlertBot` (its User-Agent) instead of posing as a person's browser, so stores can recognise it and allow or block it, including by name in robots.txt.

- **robots.txt is checked before every request.** A disallowed page is never fetched. If a store refuses to serve its robots.txt, the whole store counts as off-limits.
- **A refusal is respected.** On HTTP 401/403/429/503 or a captcha/"access denied" page, the scraper stops and reports it. Headless Chrome is used only to run the JavaScript of a page the store already served, never to retry a refused request.
- **The request rate stays low.** Tracked products are re-checked one at a time, every 6 hours by default.

Even so, many stores' terms of service restrict automated access. This is fine for a personal or academic project. For anything commercial, use the stores' official affiliate/product APIs (e.g. the Amazon Product Advertising API, Flipkart Affiliate API) instead of scraping.

---

## Setup

### Prerequisites
- Node.js 22.13+
- Python 3.9+
- PostgreSQL 13+
- Google Chrome (for the Selenium fallback)
- Optional: a Twilio account with an SMS-capable number

### 1. Install dependencies
```bash
npm install
python3 -m venv .venv
.venv/bin/pip install requests beautifulsoup4 selenium
```
The server automatically uses `.venv/bin/python` if it exists. Otherwise set `PYTHON_BIN`.

### 2. Create the database
```bash
createdb sale_alert
```
The tables, views and PL/pgSQL functions are created automatically when the server starts. You can also apply them by hand:
```bash
psql "$DATABASE_URL" -f database/schema.sql -f database/procedures.sql
```
To wipe everything: `psql "$DATABASE_URL" -f database/cleanup.sql`.

### 3. Configure `.env`
```env
# PostgreSQL: either a URL...
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/sale_alert
# ...or the standard PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE variables

# Twilio (optional: without it alerts are in-app only)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+12345678901

# Email for "Forgot password?" (optional: without it, use npm run reset-password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587                # 587 = STARTTLS, 465 = TLS
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password  # Gmail: a 16-character App Password, not your normal password
SMTP_FROM=you@gmail.com
APP_URL=http://localhost:3000   # base of the link in the email

# Optional tuning
PORT=3000
STALE_DAYS=7                 # "price hasn't changed" alert after this many days
RESCRAPE_CRON=0 */6 * * *    # how often tracked products are re-checked
COMPARE_EVERY_HOURS=24       # how often other stores are re-searched
```

### 4. Bring over data from the old SQLite version (optional)
```bash
npm run migrate:sqlite
```
This imports `database/sale_alert.db` and is safe to re-run. Old users only had a phone number. When someone registers with that phone number, they take over that user's tracked products.

### Forgot a password?
**By email:** click **Forgot password?** on the login page. A one-time link is emailed to the registered address. It works once, expires in 30 minutes, and signs the account out everywhere. At most 3 emails per address per hour. The reply is the same whether or not the email is registered. This needs the SMTP settings above; test them with `npm run check-email`.

**Without email:** the owner of the machine can reset it from the terminal:
```bash
npm run reset-password -- you@example.com
```
You're asked for the new password twice at a hidden prompt. Any existing logins for that account are signed out.

### 5. Run
```bash
npm start
```
Open http://localhost:3000, create an account and track a product.

---

## Database schema

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : "logs in"
    USERS ||--o{ TRACKING : tracks
    PRODUCTS ||--o{ TRACKING : "is tracked"
    PRODUCTS ||--o{ PRICE_HISTORY : "price changes"
    PRODUCTS ||--o{ COMPETITOR_PRICES : "other stores"
    USERS ||--o{ ALERTS : receives
    PRODUCTS ||--o{ ALERTS : triggers

    USERS { bigint user_id PK
            text name
            text email UK
            text password_hash
            text phone_number UK }
    SESSIONS { text token_hash PK
               bigint user_id FK
               timestamptz expires_at }
    PRODUCTS { bigint product_id PK
               text name
               text url UK
               text site
               text currency
               numeric original_price
               text offer
               timestamptz last_checked_at
               timestamptz last_compared_at }
    TRACKING { bigint tracking_id PK
               bigint user_id FK
               bigint product_id FK
               numeric target_price }
    PRICE_HISTORY { bigint history_id PK
                    bigint product_id FK
                    numeric price
                    numeric original_price
                    timestamptz observed_at }
    COMPETITOR_PRICES { bigint id PK
                        bigint product_id FK
                        text site
                        text title
                        text url
                        numeric price
                        timestamptz checked_at }
    ALERTS { bigint alert_id PK
             bigint user_id FK
             bigint product_id FK
             text kind
             numeric price
             text message
             jsonb details
             boolean sent
             timestamptz read_at }
```

Views `latest_prices` and `latest_competitor_prices` give the current price per product and per (product, store).

**Passwords** are hashed with scrypt and a per-user salt. **Sessions** are random tokens in an `HttpOnly`, `SameSite=Lax` cookie; only their SHA-256 hash is stored. Login is throttled to 10 failed attempts per email per 15 minutes.

---

## REST API

All `/api` routes except register/login need the session cookie; they return `401` otherwise.

| Method & path | Body | Purpose |
| --- | --- | --- |
| `POST /api/auth/register` | `{name, email, password, phone_number?}` | Create an account and log in |
| `POST /api/auth/login` | `{email, password}` | Log in |
| `POST /api/auth/logout` | | Log out |
| `GET /api/auth/me` | | Current user, and whether SMS is enabled |
| `PATCH /api/auth/me` | `{name?, phone_number?}` | Update profile / SMS number |
| `POST /api/track` | `{user_input, target_price}` | Scrape and start tracking a product |
| `GET /api/products` | | Tracked products with latest price, last change, best other-store price |
| `GET /api/products/:id` | | Full price history, other-store prices and their history |
| `PATCH /api/products/:id` | `{target_price}` | Change the target |
| `DELETE /api/products/:id` | | Stop tracking |
| `POST /api/products/:id/refresh` | | Re-check the price now |
| `POST /api/products/:id/compare` | | Search the other stores now |
| `GET /api/alerts` | | Latest 50 notifications and the unread count |
| `POST /api/alerts/read` | | Mark all notifications read |

---

## File structure

```
.
├── server.js               # Express routes, page guards, cron jobs
├── lib/
│   ├── db.js               # pg pool, schema bootstrap, transactions
│   ├── auth.js             # password hashing, sessions, login throttling
│   ├── scraper.js          # runs webscrape.py
│   └── notify.js           # SMS text + Twilio dispatch
├── webscrape.py            # scrape / compare modes
├── scripts/migrate-sqlite.js
├── database/
│   ├── schema.sql          # tables, indexes, views
│   ├── procedures.sql      # PL/pgSQL alert functions
│   └── cleanup.sql         # drops everything
└── public/
    ├── login.html, register.html
    ├── index.html          # track a product, SMS number
    ├── history.html        # dashboard + notifications
    ├── product.html        # graph, history, other stores, offers
    ├── css/app.css
    └── js/common.js
```

---

## Known limitations

- **Scraping is fragile.** Stores change their markup and block bots. Amazon serves a bot-check page to plain requests, so it usually needs the Selenium fallback, which takes 10–30 seconds per page.
- **Store matching is by name.** The "other stores" result is the closest listing by title, which may be a different colour, storage size or generation. The UI shows the listing title so the user can check.
- **Comparison only covers three stores** (Amazon.in, Snapdeal, ShopClues), because the others disallow, block or ignore an openly identified bot. Also checked and ruled out (Oct 2026): Poorvika, boAt, Lenskart, Pepperfry, Purplle, BigBasket and Bewakoof disallow bots in robots.txt; Croma refuses; FirstCry, Pai International and Sangeetha don't show readable results.
- **Tata CLiQ and JioMart product pages are untested.** They're read via the generic structured-data rules, since no product link could be found to test with.
- **Bank and card offers aren't captured.** "Offers" means the MRP discount and deal badges shown on the product page.

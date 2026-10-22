#webscrape.py
"""
Price scraper driven by server.js. Prints one JSON object as its last stdout line.
Identifies itself to stores as SaleAlertBot (see HEADERS).

  python webscrape.py scrape <url-or-search-query>
      -> {success, site, url, currency, product_name, price, original_price, offer, raw_text,
          message, error?}   error: "unsupported" | "disallowed" | "blocked"

  python webscrape.py compare <product name> [site-to-skip] [tracked price]
      -> {success, query, results: [{site, title, price, url, match, match_type}], misses: {site: reason}}
      match_type "exact" = the same product; "similar" = the store doesn't sell it, so
      this is the closest product it does sell.

Indian stores only. The scraper plays by each store's rules:
  - every URL is checked against the store's robots.txt first;
  - if a store refuses the request (HTTP 401/403/429/503 or a captcha page) we stop
    there; headless Chrome is only used to render JavaScript on pages the store served.

SMS sending lives in server.js; this script only reads prices.
"""

import sys
import re
import json
from concurrent.futures import ThreadPoolExecutor
from urllib import robotparser
from urllib.parse import urljoin, urlsplit, quote_plus

import requests
from bs4 import BeautifulSoup

# Selenium imports
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException, WebDriverException


# --- Supported stores (all Indian, all priced in INR) ---
# domains:  URL fragments that identify the store
# aliases:  words that pick the store for a plain-text query ("snapdeal boat airdopes")
# search:   search URL template ({q} = url-encoded query, {slug} = query-with-dashes).
#           Only stores whose robots.txt allows their search pages and that show
#           results without a login/location have one; the rest are tracking-only.
SITES = {
    "amazon":          {"name": "Amazon.in", "domains": ["amazon.in"], "aliases": ["amazon"],
                        "search": "https://www.amazon.in/s?k={q}"},
    "snapdeal":        {"name": "Snapdeal", "domains": ["snapdeal.com"], "aliases": ["snapdeal"],
                        "search": "https://www.snapdeal.com/search?keyword={q}"},
    "shopclues":       {"name": "ShopClues", "domains": ["shopclues.com"], "aliases": ["shopclues"],
                        "search": "https://www.shopclues.com/search?q={q}"},
    "flipkart":        {"name": "Flipkart", "domains": ["flipkart.com"], "aliases": ["flipkart"]},
    "reliancedigital": {"name": "Reliance Digital", "domains": ["reliancedigital.in"], "aliases": ["reliance"]},
    "tatacliq":        {"name": "Tata CLiQ", "domains": ["tatacliq.com"], "aliases": ["tatacliq"]},
    "jiomart":         {"name": "JioMart", "domains": ["jiomart.com"], "aliases": ["jiomart"]},
    "vijaysales":      {"name": "Vijay Sales", "domains": ["vijaysales.com"], "aliases": ["vijaysales"]},
}

# Indian stores that refuse automated requests outright, so we don't try
# (Myntra serves browsers but silently ignores clients that identify as bots)
REFUSING_STORES = {"myntra.com": "Myntra", "ajio.com": "Ajio", "nykaa.com": "Nykaa", "nykaafashion.com": "Nykaa Fashion",
                   "croma.com": "Croma", "meesho.com": "Meesho"}


def detect_site(url):
    host = urlsplit(url).hostname or ""
    for site, cfg in SITES.items():
        if any(host == d or host.endswith("." + d) for d in cfg["domains"]):
            return site
    return None


def search_url(site, query):
    words = re.findall(r'[a-z0-9]+', query.lower())
    return SITES[site]["search"].format(q=quote_plus(query), slug="-".join(words))


def unsupported(message, url=""):
    return {"success": False, "error": "unsupported", "url": url, "price": None, "message": message}


# --- Detect site & build URL ---
# Returns (site, url) or (None, error-result)
def detect_site_and_build_url(inp):
    s = inp.strip()
    lower = s.lower()
    if lower.startswith("http://") or lower.startswith("https://"):
        site = detect_site(s)
        if site:
            return site, s
        host = urlsplit(s).hostname or ""
        for domain, name in REFUSING_STORES.items():
            if host == domain or host.endswith("." + domain):
                return None, unsupported(f"{name} doesn't allow automated price checks, so it can't be tracked.", s)
        stores = ", ".join(cfg["name"] for cfg in SITES.values())
        return None, unsupported(f"Only these Indian stores are supported: {stores}.", s)

    # Plain text: "snapdeal boat airdopes" searches Snapdeal; no store named -> Amazon.in
    words = set(re.findall(r'[a-z]+', lower))
    for name in REFUSING_STORES.values():
        if name.split()[0].lower() in words:
            return None, unsupported(f"{name} doesn't allow automated price checks, so it can't be searched.")
    named = [site for site, cfg in SITES.items() if words & set(cfg["aliases"])]
    if len(named) == 1:
        site = named[0]
        if not SITES[site].get("search"):
            return None, unsupported(f"{SITES[site]['name']} can't be searched automatically — paste a product link instead.")
        q = s
        for alias in SITES[site]["aliases"]:
            q = re.sub(r'\b' + alias + r'\b[:\s]*', '', q, count=1, flags=re.I)
        return site, search_url(site, q.strip())
    return "amazon", search_url("amazon", s)


def parse_price_string(price_str):
    if not price_str:
        return None, ""
    raw = price_str.replace("\xa0", " ").strip()
    m = re.search(r'(\d[\d,]*(?:\.\d+)?)', raw)  # handles 1299, 1,299.00 and 1,65,000
    if not m:
        return None, raw
    cleaned = m.group(1).replace(",", "")
    try:
        return float(cleaned), raw
    except:
        return None, raw


def clean_text(s):
    return re.sub(r'\s+', ' ', s or "").strip()


# --- Requests headers ---
# The scraper says honestly what it is rather than posing as a person's browser, so a
# store can recognise it, and allow or block it, under this name in its robots.txt.
BOT_NAME = "SaleAlertBot"
HEADERS = {
    "User-Agent": f"{BOT_NAME}/1.0 (personal price tracker; checks a few public product pages every few hours)",
    "Accept-Language": "en-IN,en;q=0.9",
}

# --- robots.txt ---
_robots = {}


def robots_allows(url):
    """True if the store's robots.txt lets automated clients fetch `url`.
    No robots.txt (404) means no rules; a refused (401/403) or unreachable
    robots.txt is treated as "no", per RFC 9309's cautious reading."""
    parts = urlsplit(url)
    root = f"{parts.scheme}://{parts.netloc}"
    if root not in _robots:
        rp = robotparser.RobotFileParser()
        try:
            r = requests.get(root + "/robots.txt", headers=HEADERS, timeout=15)
            if r.status_code == 404 or r.status_code == 410:
                rp.allow_all = True
            elif r.status_code >= 400:
                rp.disallow_all = True
            else:
                rp.parse(r.text.splitlines())
        except Exception:
            rp.disallow_all = True
        _robots[root] = rp
    # Rules written for SaleAlertBot apply if the store has any; otherwise the "*" rules
    return _robots[root].can_fetch(BOT_NAME, url)


# Bot walls served instead of the page
BLOCKED_STATUS = {401, 403, 429, 503}
BLOCKED_RE = re.compile(r'access denied|captcha|are you a robot|pardon our interruption|robot check', re.I)


def looks_blocked(html):
    soup_title = re.search(r'<title[^>]*>(.*?)</title>', html[:5000], re.S | re.I)
    head = soup_title.group(1) if soup_title else html[:3000]
    return len(html) < 20000 and bool(BLOCKED_RE.search(head))


def fetch_html(url, timeout=18):
    """Returns (html, status): status is "ok", "disallowed", "blocked" or "error"."""
    if not robots_allows(url):
        return "", "disallowed"
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
    except Exception:
        return "", "error"
    if r.status_code in BLOCKED_STATUS:
        return "", "blocked"
    if r.status_code >= 400:
        return "", "error"
    # Without a charset header requests assumes Latin-1, which turns "₹" into "â¹"
    if "charset" not in r.headers.get("Content-Type", "").lower():
        r.encoding = "utf-8"
    if looks_blocked(r.text):
        return "", "blocked"
    return r.text, "ok"


# --- Selenium: only to run the JavaScript of a page the store already served ---
def selenium_page_source(url, wait_selectors, timeout=15, headless=True):
    options = webdriver.ChromeOptions()
    if headless:
        try:
            options.add_argument("--headless=new")
        except:
            options.add_argument("--headless")
        options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--ignore-certificate-errors")
    options.add_argument(f"--user-agent={HEADERS['User-Agent']}")

    try:
        driver = webdriver.Chrome(options=options)
    except WebDriverException:
        return ""

    try:
        driver.get(url)
        try:
            WebDriverWait(driver, timeout).until(
                lambda d: any(d.find_elements(By.CSS_SELECTOR, sel) for sel in wait_selectors))
        except TimeoutException:
            pass
        html = driver.page_source
        return "" if looks_blocked(html) else html
    except Exception:
        return ""
    finally:
        try:
            driver.quit()
        except:
            pass


# --- Product page selectors ---
# Stores not listed rely on JSON-LD, price meta tags and the generic MRP/discount rules
PRICE_SELECTORS = {
    "amazon": ["#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen", "#corePrice_feature_div .a-offscreen",
               ".priceToPay .a-offscreen", "#priceblock_dealprice", "#priceblock_ourprice",
               "span.a-price > span.a-offscreen", ".a-price-whole"],
    "flipkart": [".Nx9bqj.CxhGGd", "div._30jeq3._1_WHN1", "div._30jeq3", "span._30jeq3"],
    "snapdeal": ["span.payBlkBig", ".pdp-final-price"],
    "shopclues": [".prd_price .f_price", ".f_price", ".p_price"],
    "reliancedigital": [".product-price", ".pdp__offerPrice"],
    "tatacliq": [".ProductDetailsMainCard__price h3", "[class*='ProductDescription__price']"],
    "jiomart": [".product-price .jm-heading-xs", "#price_section .final-price"],
    "vijaysales": [".product__price--price", "[class*='priceSp']"],
    "unknown": ["[itemprop='price']", "[class*='price' i]"],
}

# MRP / list price shown struck-through next to the sale price
ORIGINAL_PRICE_SELECTORS = {
    "amazon": ["#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen", ".basisPrice .a-offscreen",
               "#corePrice_desktop .a-text-price .a-offscreen", "#listPrice", "#priceblock_listprice"],
    "flipkart": [".yRaY8j", "._3I9_wc"],
    "snapdeal": [".pdpCutPrice"],
    "shopclues": [".o_price1", ".old_prices"],
    "reliancedigital": [".product-marked-price"],
}
GENERIC_ORIGINAL_PRICE = ["[class*='mrp' i]", "[class*='marked-price' i]", "[class*='strike' i]", "[class*='old-price' i]",
                          "[class*='oldprice' i]", "[class*='was-price' i]", "del", "s"]

# Deal badges / discount labels
OFFER_SELECTORS = {
    "amazon": ["#dealBadge_feature_div", ".savingsPercentage"],
    "flipkart": [".UkUFwK", "._3Ay6Sb"],
    "snapdeal": [".pdpDiscount"],
}
GENERIC_OFFER = ["[class*='discount' i]", "[class*='offer-badge' i]", "[class*='deal' i]"]

NAME_SELECTORS = {
    "flipkart": [".VU-ZEz", "._35KyD6", "span.B_NuCI", "h1"],
    "amazon": ["#productTitle", "span#productTitle", "h1#title", "h1"],
    "snapdeal": ["h1.pdp-e-i-head", "h1"],
    "unknown": ["h1", "title"]
}


# --- Structured data (JSON-LD): stable across redesigns, unlike CSS class names ---
def find_ld_product(node):
    if isinstance(node, list):
        for item in node:
            found = find_ld_product(item)
            if found:
                return found
    elif isinstance(node, dict):
        types = node.get("@type")
        if (types == "Product" or (isinstance(types, list) and "Product" in types)) and node.get("offers"):
            return node
        if "@graph" in node:
            return find_ld_product(node["@graph"])
    return None


def first_text(soup, selectors):
    for sel in selectors:
        try:
            node = soup.select_one(sel)
        except Exception:
            node = None
        if node:
            txt = clean_text(node.get_text(" "))
            if txt:
                return txt
    return ""


def first_price(soup, selectors, above=None):
    # First element under `selectors` whose text is a price (and, for MRPs, above the sale price)
    for sel in selectors:
        try:
            nodes = soup.select(sel)[:10]
        except Exception:
            continue
        for node in nodes:
            txt = clean_text(node.get_text(" "))
            if not txt or len(txt) > 40 or not re.search(r'\d', txt):
                continue
            val, _ = parse_price_string(txt)
            if val and (above is None or val > above):
                return val, txt
    return None, ""


def embedded_mrp(html, price):
    # App state like {"finalPrice":799,"mrp":3990} (Flipkart and others). Only trust an
    # "mrp" sitting next to the product's own price, not a recommended product's.
    price_re = re.compile(r'[:"]\s*%s(?:\.0+)?\s*[,}"]' % re.escape(f"{price:g}"))
    for m in re.finditer(r'"mrp"\s*:\s*"?(\d+(?:\.\d+)?)', html):
        mrp = float(m.group(1))
        if price < mrp <= price * 10 and price_re.search(html[max(0, m.start() - 300):m.end() + 300]):
            return mrp
    return None


def extract_product(html, site):
    info = {"price": None, "raw_text": "", "product_name": "", "original_price": None, "offer": ""}
    if not html:
        return info
    soup = BeautifulSoup(html, "html.parser")

    for script in soup.select('script[type="application/ld+json"]'):
        try:
            product = find_ld_product(json.loads(script.get_text()))
        except Exception:
            continue
        if not product:
            continue
        offers = product["offers"]
        offer = offers[0] if isinstance(offers, list) and offers else offers
        if isinstance(offer, dict):
            ld_price = offer.get("price") or offer.get("lowPrice")
            pval, _ = parse_price_string(str(ld_price)) if ld_price is not None else (None, "")
            if pval:
                info["price"] = pval
                info["raw_text"] = f"{offer.get('priceCurrency', '')} {pval:g}".strip()
        if isinstance(product.get("name"), str):
            name = clean_text(product["name"])
            brand = product.get("brand")
            brand = clean_text(brand.get("name") if isinstance(brand, dict) else brand if isinstance(brand, str) else "")
            # Some stores leave the brand out of the name
            info["product_name"] = name if not brand or brand.lower() in name.lower() else f"{brand} {name}"
        if info["price"] is not None:
            break

    if info["price"] is None:
        val, txt = first_price(soup, PRICE_SELECTORS.get(site, []) + PRICE_SELECTORS["unknown"])
        if val:
            info["price"], info["raw_text"] = val, txt

    if info["price"] is None:
        for sel in ['meta[property="product:price:amount"]', 'meta[property="og:price:amount"]', 'meta[itemprop="price"]']:
            node = soup.select_one(sel)
            val, _ = parse_price_string(node.get("content", "")) if node else (None, "")
            if val:
                info["price"], info["raw_text"] = val, node["content"]
                break

    if not info["product_name"]:
        info["product_name"] = first_text(soup, NAME_SELECTORS.get(site, NAME_SELECTORS["unknown"]))

    if info["price"] and not info["original_price"]:
        mrp, _ = first_price(soup, ORIGINAL_PRICE_SELECTORS.get(site, []) + GENERIC_ORIGINAL_PRICE, above=info["price"])
        # Ignore wild values (an unrelated product's price elsewhere on the page)
        if mrp and mrp <= info["price"] * 10:
            info["original_price"] = mrp
        else:
            info["original_price"] = embedded_mrp(html, info["price"])

    if not info["offer"]:
        offers = []
        for sel in OFFER_SELECTORS.get(site, []) + GENERIC_OFFER:
            txt = first_text(soup, [sel])
            # Short labels only: longer text is usually a filter list ("20% and above 30% and above ...")
            if txt and len(txt) <= 40 and re.search(r'\d+\s?%|deal|sale|off', txt, re.I) and txt not in offers:
                offers.append(txt)
            if len(offers) == 2:
                break
        info["offer"] = " · ".join(offers)[:120]

    if info["original_price"] and info["price"] and info["original_price"] <= info["price"]:
        info["original_price"] = None
    if not info["raw_text"] and soup.title:
        info["raw_text"] = clean_text(soup.title.string or "")
    return info


FETCH_MESSAGES = {
    "disallowed": "This store's robots.txt doesn't allow automated access to this page.",
    "blocked": "The store refused the automated price check.",
    "error": "The store page couldn't be loaded.",
}


def scrape(user_input):
    site, url = detect_site_and_build_url(user_input)
    if site is None:
        return url  # an "unsupported" result

    html, status = fetch_html(url)
    info = extract_product(html, site)

    # Some stores render prices with JavaScript: render the page they served
    if status == "ok" and (info["price"] is None or not info["product_name"]):
        rendered = extract_product(selenium_page_source(url, PRICE_SELECTORS.get(site, PRICE_SELECTORS["unknown"])), site)
        for key, val in rendered.items():
            if val and not info[key]:
                info[key] = val
        if info["price"] is not None and info["original_price"] and info["original_price"] <= info["price"]:
            info["original_price"] = None

    name = info["product_name"]
    if name and len(name) > 200:
        info["product_name"] = name[:197] + "..."

    result = {
        "success": info["price"] is not None,
        "site": site,
        "url": url,
        "currency": "INR",
        **info,
        "message": "",
    }
    if status != "ok":
        result["error"] = status if status != "error" else None
        result["message"] = FETCH_MESSAGES[status]
    elif info["price"] is None:
        result["message"] = "No numeric price found on the page."
    return result


# --- Searching other stores ---
# Each parser returns [{title, price, url}].

def parse_amazon_search(soup, base, html):
    items = []
    for card in soup.select('div[data-component-type="s-search-result"]'):
        if card.select_one(".puis-sponsored-label-text"):
            continue  # ads are often for different products
        # The first <h2> is sometimes just the brand; take the fullest title on offer
        recipe = card.select_one('[data-cy="title-recipe"]')
        img = card.select_one("img.s-image[alt]")
        candidates = [recipe.get_text(" ") if recipe else "",
                      " ".join(h.get("aria-label") or h.get_text(" ") for h in card.select("h2")),
                      img["alt"] if img else ""]
        title = max((clean_text(c) for c in candidates), key=len)
        title = re.sub(r'^Sponsored Ad\s*[-–]\s*', '', title)
        link = card.select_one('a[href*="/dp/"]')
        price_el = card.select_one(".a-price:not(.a-text-price) .a-offscreen")
        price, _ = parse_price_string(price_el.get_text() if price_el else "")
        if not (title and price and link):
            continue
        href = urljoin(base, link["href"])
        m = re.search(r'/dp/([A-Z0-9]{10})', href)
        items.append({"title": title, "price": price,
                      "url": f"https://www.amazon.in/dp/{m.group(1)}" if m else href})
    return items


def parse_snapdeal_search(soup, base, html):
    items = []
    for card in soup.select(".product-tuple-listing"):
        t = card.select_one(".product-title")
        p = card.select_one(".product-price")
        link = card.select_one("a.dp-widget-link") or card.select_one("a[href]")
        if not (t and p and link):
            continue
        price, _ = parse_price_string(p.get("display-price") or p.get("data-price") or p.get_text())
        title = clean_text(t.get("title") or t.get_text(" "))
        if title and price:
            items.append({"title": title, "price": price, "url": urljoin(base, link["href"])})
    return items


def parse_shopclues_search(soup, base, html):
    items = []
    for card in soup.select("div.search_blocks"):
        link = card.select_one("a[href]")
        price_el = card.select_one(".p_price")
        if not (link and price_el):
            continue
        price, _ = parse_price_string(price_el.get_text())
        # The visible heading is cut short; the image alt / title attributes carry the full name
        candidates = [card.select_one("h2").get_text(" ") if card.select_one("h2") else ""]
        candidates += [img.get("alt", "") for img in card.select("img[alt]")]
        candidates += [t.get("title", "") for t in card.select("[title]")]
        candidates.append(card.get_text(" ").split("₹")[0])
        title = max((clean_text(c) for c in candidates if c and "₹" not in c), key=len, default="")
        if title and price:
            items.append({"title": title, "price": price, "url": urljoin("https:", link["href"].split("?")[0])})
    return items


SEARCH_PARSERS = {
    "amazon":   (parse_amazon_search, ['div[data-component-type="s-search-result"]']),
    "snapdeal": (parse_snapdeal_search, [".product-tuple-listing"]),
    "shopclues": (parse_shopclues_search, ["div.search_blocks"]),
}

STOPWORDS = {"a", "an", "and", "the", "for", "with", "of", "in", "on", "to", "by", "from", "new", "latest", "buy", "online"}


def tokens(s):
    # Single letters are noise ("Women's" -> "women", "s"); single digits are kept (model numbers)
    return [t for t in re.findall(r'[a-z0-9]+', (s or "").lower())
            if t not in STOPWORDS and (len(t) > 1 or t.isdigit())]


MULTIPACK_RE = re.compile(r'\b(pack|set|combo) of \d+|\btwin pack\b|\bcombo\b', re.I)
GENDERS = {"men": "men", "mens": "men", "man": "men", "boys": "boys", "boy": "boys",
           "women": "women", "womens": "women", "woman": "women", "ladies": "women", "girls": "girls", "girl": "girls"}


def gender_of(toks):
    found = {GENDERS[t] for t in toks if t in GENDERS}
    return found.pop() if len(found) == 1 else None


def match_score(query_tokens, title):
    # Share of the query's words found in the listing title: a good match
    # contains the brand, model and variant (e.g. "128", "gb", "black").
    if not query_tokens:
        return 0.0
    title_tokens = set(tokens(title))
    # Names start with brand + model: "Nike Run Defy ..." must not match "Nike Run Swift ..."
    if any(t not in title_tokens for t in query_tokens[:3]):
        return 0.0
    # Numbers are model / size identifiers: "iPhone 16" must not match "iPhone 15"
    if any(t.isdigit() and t not in title_tokens for t in query_tokens):
        return 0.0
    # A multi-pack's price isn't comparable with a single item's
    if MULTIPACK_RE.search(title) and not MULTIPACK_RE.search(" ".join(query_tokens)):
        return 0.0
    # Men's and women's versions are different products
    q_gender, t_gender = gender_of(query_tokens), gender_of(tokens(title))
    if q_gender and t_gender and q_gender != t_gender:
        return 0.0
    return sum(1 for t in query_tokens if t in title_tokens) / len(query_tokens)


MIN_MATCH = 0.6

ACCESSORY_WORDS = {"case", "cover", "screen", "guard", "protector", "tempered", "glass", "charger", "cable",
                   "adapter", "strap", "skin", "pouch", "stand", "holder", "sticker", "refill", "magsafe"}


def similarity(query_tokens, title):
    """Looser score for the "closest product" fallback when nothing matches exactly:
    share of the query's words in the title, with the brand (first word) counting triple, so
    the same brand's nearest model beats another brand's lookalike.
    Accessories and multi-packs are never offered as a stand-in for the product."""
    if not query_tokens:
        return 0.0
    title_tokens = tokens(title)
    if ACCESSORY_WORDS & set(title_tokens) and not ACCESSORY_WORDS & set(query_tokens):
        return 0.0
    if MULTIPACK_RE.search(title) and not MULTIPACK_RE.search(" ".join(query_tokens)):
        return 0.0
    title_tokens = set(title_tokens)
    weights = [3] + [1] * (len(query_tokens) - 1)
    return sum(w for t, w in zip(query_tokens, weights) if t in title_tokens) / sum(weights)


MIN_SIMILAR = 0.3   # below this a "similar" product has too little in common to be worth showing
SIMILAR_PRICE_RANGE = (0.25, 4)   # a stand-in must cost 1/4x-4x the tracked price (a ₹999 case is no stand-in for a phone)


def fetch_search_items(site, query):
    """Returns (items, miss-reason)."""
    parser, wait = SEARCH_PARSERS[site]
    url = search_url(site, query)
    html, status = fetch_html(url)
    if status == "disallowed":
        return [], "search not allowed by the store's robots.txt"
    if status == "blocked":
        return [], "the store refused the automated search"
    if status != "ok":
        return [], "the store couldn't be reached"
    items = parser(BeautifulSoup(html, "html.parser"), url, html)
    if not items:
        # Results rendered by JavaScript
        rendered = selenium_page_source(url, wait)
        if rendered:
            items = parser(BeautifulSoup(rendered, "html.parser"), url, rendered)
    return items, None if items else "no results"


def best_by(items, score_fn, minimum, ref_price=None):
    best = None
    for item in items[:30]:
        if ref_price and not (SIMILAR_PRICE_RANGE[0] * ref_price <= item["price"] <= SIMILAR_PRICE_RANGE[1] * ref_price):
            continue
        score = score_fn(item["title"])
        if score >= minimum and (best is None or score > best["match"]):
            best = {**item, "match": round(score, 2)}
    return best


def search_site(site, query, query_tokens, ref_price=None):
    items, reason = fetch_search_items(site, query)
    if not items:
        return None, reason

    exact = best_by(items, lambda t: match_score(query_tokens, t), MIN_MATCH)
    if exact:
        return {"site": site, **exact, "match_type": "exact"}, None

    # Not sold there: fall back to the closest product it does sell
    similar = best_by(items, lambda t: similarity(query_tokens, t), MIN_SIMILAR, ref_price)
    if (not similar or similar["match"] < 0.5) and len(query_tokens) > 2:
        # Weak results for the full name: try just brand + product line ("boat airdopes")
        broader, _ = fetch_search_items(site, " ".join(query_tokens[:2]))
        candidate = best_by(broader, lambda t: similarity(query_tokens, t), MIN_SIMILAR, ref_price)
        if candidate and (not similar or candidate["match"] > similar["match"]):
            similar = candidate
    if not similar:
        return None, "nothing similar found"
    return {"site": site, **similar, "match_type": "similar"}, None


def core_name(name):
    # Listing titles append feature lists: "boAt Airdopes 141/8, Low Latency, ENx Tech, ..."
    # Keep brand + model + variant (before the first ",", "|" or " - "), minus "/8"-style suffixes.
    core = re.split(r',|\||\s[-–]\s', name or "", maxsplit=1)[0]
    core = re.sub(r'/\w+', '', core)
    return core if len(tokens(core)) >= 2 else name


def compare(product_name, skip_site="", ref_price=None):
    query_tokens = tokens(core_name(product_name))[:10]
    query = " ".join(query_tokens)
    sites = [s for s in SEARCH_PARSERS if s != skip_site]
    results, misses = [], {}
    with ThreadPoolExecutor(max_workers=len(sites) or 1) as pool:
        for site, (found, reason) in zip(sites, pool.map(lambda s: search_site(s, query, query_tokens, ref_price), sites)):
            if found:
                results.append(found)
            else:
                misses[site] = reason
    results.sort(key=lambda r: r["price"])
    return {"success": True, "query": query, "results": results, "misses": misses}


def main():
    args = sys.argv[1:]
    mode = args[0] if args else ""
    try:
        if mode == "scrape" and len(args) > 1 and args[1].strip():
            result = scrape(args[1])
        elif mode == "compare" and len(args) > 1 and args[1].strip():
            ref_price = parse_price_string(args[3])[0] if len(args) > 3 else None
            result = compare(args[1], args[2] if len(args) > 2 else "", ref_price)
        else:
            result = {"success": False, "message": "usage: webscrape.py scrape <url-or-query> | compare <name> [skip-site] [price]"}
    except Exception as e:
        result = {"success": False, "message": f"Scraper error: {e}"}
    # Return JSON to Node.js
    print(json.dumps(result))


if __name__ == "__main__":
    main()

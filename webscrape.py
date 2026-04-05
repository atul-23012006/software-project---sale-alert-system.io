#webscrape.py

import oracledb
import sys
import re
import os
import json
import traceback
import time
from dotenv import load_dotenv
import requests
from bs4 import BeautifulSoup
from twilio.rest import Client

# Selenium imports
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException

load_dotenv()

# --- Input handling ---
args = sys.argv
user_input = args[1].strip() if len(args) > 1 else ""
try:
    target_price = float(args[2]) if len(args) > 2 and args[2] != "" else 0.0
except Exception:
    target_price = 0.0
phone_number = args[3] if len(args) > 3 else ""

# Twilio credentials from env
TW_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TW_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TW_FROM = os.environ.get("TWILIO_FROM_NUMBER", "+17625503038")




# --- Detect site & build URL ---
def detect_site_and_build_url(inp):
    s = inp.strip()
    lower = s.lower()
    if lower.startswith("http://") or lower.startswith("https://"):
        if "flipkart" in lower:
            return "flipkart", s
        if "ebay" in lower:
            return "ebay", s
        if "amazon." in lower:
            return "amazon", s
        return "unknown", s
    if "flipkart" in lower and "amazon" not in lower and "ebay" not in lower:
        q = re.sub(r'flipkart[:\s]*', '', lower, count=1).strip().replace(" ", "+")
        return "flipkart", f"https://www.flipkart.com/search?q={q}"
    if "ebay" in lower and "flipkart" not in lower and "amazon" not in lower:
        q = re.sub(r'ebay[:\s]*', '', lower, count=1).strip().replace(" ", "+")
        return "ebay", f"https://www.ebay.com/sch/i.html?_nkw={q}"
    if "amazon" in lower and "flipkart" not in lower and "ebay" not in lower:
        q = re.sub(r'amazon[:\s]*', '', lower, count=1).strip().replace(" ", "+")
        return "amazon", f"https://www.amazon.com/s?k={q}"
    q = s.replace(" ", "+")
    return "amazon", f"https://www.amazon.com/s?k={q}"

def parse_price_string(price_str):
    if not price_str:
        return None, ""
    raw = price_str.replace("\xa0", " ").strip()
    m = re.search(r'(\d{1,3}(?:[,\.\s]\d{3})*(?:[.,]\d+)?|\d+([.,]\d+)?)', raw)
    if not m:
        return None, raw
    cleaned = m.group(1).replace(",", "")
    try:
        return float(cleaned), raw
    except:
        return None, raw

# --- Requests headers ---
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Dnt": "1",
}

# --- Selenium helper ---
def selenium_collect_price_text(url, selectors, timeout=12, headless=True):
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

    try:
        driver = webdriver.Chrome(options=options)
    except WebDriverException:
        return None, ""

    found_texts = []
    price_val = None
    try:
        driver.get(url)
        wait = WebDriverWait(driver, timeout)
        for sel in selectors:
            try:
                wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR, sel)))
                elems = driver.find_elements(By.CSS_SELECTOR, sel)
            except TimeoutException:
                elems = []
            if not elems:
                continue
            for el in elems:
                t = el.text.strip()
                if not t:
                    continue
                found_texts.append(t)
                if price_val is None:
                    v, raw = parse_price_string(t)
                    if v is not None:
                        price_val = v
            if found_texts:
                break
    except Exception:
        pass
    finally:
        try:
            driver.quit()
        except:
            pass
    return price_val, " | ".join(found_texts)

def selenium_collect_name(url, selectors, timeout=10, headless=True):
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

    try:
        driver = webdriver.Chrome(options=options)
    except WebDriverException:
        return ""

    try:
        driver.get(url)
        wait = WebDriverWait(driver, timeout)
        for sel in selectors:
            try:
                wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, sel)))
                el = driver.find_element(By.CSS_SELECTOR, sel)
                text = el.text.strip()
                if text:
                    return text
            except TimeoutException:
                continue
            except Exception:
                continue
    except Exception:
        pass
    finally:
        try:
            driver.quit()
        except:
            pass
    return ""

# --- Main scraping logic ---
site, url = detect_site_and_build_url(user_input)

site_selectors = {
    "amazon": ["span.a-price > span.a-offscreen", ".a-price-whole", "#priceblock_ourprice", "#priceblock_dealprice"],
    "flipkart": [".Nx9bqj.CxhGGd", "div._30jeq3._1_WHN1", "div._30jeq3", "span._30jeq3"],
    "ebay": [".ux-textspans", ".s-item__price", ".ux-price"],
    "unknown": [".Nx9bqj.CxhGGd", ".ux-textspans", ".s-item__price"]
}
selectors = site_selectors.get(site, site_selectors["unknown"])

name_selectors = {
    "flipkart": [".VU-ZEz", "._35KyD6", "span.B_NuCI"],
    "amazon": ["#productTitle", "span#productTitle", "h1#title", "h1"],
    "ebay": ["h1[itemprop='name']", ".ux-layout-section__title", ".it-ttl"],
    "unknown": ["h1", "title"]
}
name_sel = name_selectors.get(site, name_selectors["unknown"])

page_html = ""
try:
    r = requests.get(url, headers=HEADERS, timeout=18)
    r.raise_for_status()
    page_html = r.text
except Exception:
    page_html = ""

soup = BeautifulSoup(page_html, "html.parser") if page_html else None

price = None
raw_text = ""
product_name = ""

if soup:
    for sel in selectors:
        try:
            node = soup.select_one(sel)
        except Exception:
            node = None
        if node:
            txt = node.get_text().strip()
            if txt:
                raw_text = txt
                pval, _ = parse_price_string(txt)
                if pval is not None:
                    price = pval
                break

if soup:
    for sel in name_sel:
        try:
            node = soup.select_one(sel)
        except Exception:
            node = None
        if node:
            nm = node.get_text().strip()
            if nm:
                product_name = nm
                break

if (not raw_text or price is None):
    try:
        selenium_price, selenium_text = selenium_collect_price_text(url, selectors, timeout=15, headless=True)
        if selenium_text and not raw_text:
            raw_text = selenium_text
        if selenium_price is not None and price is None:
            price = selenium_price
    except Exception:
        pass

if not product_name:
    try:
        product_name = selenium_collect_name(url, name_sel, timeout=12, headless=True)
    except Exception:
        product_name = product_name or ""

if not raw_text and soup:
    try:
        raw_text = (soup.title.string or "").strip()
    except Exception:
        raw_text = ""

# --- Trim product name if it's too long (100 chars) ---
if product_name and len(product_name) > 100:
    product_name = product_name[:97] + "..."

# --- Compose SMS message (multi-line) ---
if product_name:
    # raw_text often contains the currency symbol; prefer that for the price line
    price_line = raw_text if raw_text else (f"Price: {price}" if price is not None else "Price not found")
    message_text = f"""🔥 DEAL ALERT!

    📦 {product_name}
    💰 Price: {price_line}

    🎯 Your target price is reached — act fast before it’s gone!"""
    
else:
    # fallback to the old single-line/text behavior but in a readable message
    display_price = raw_text if raw_text else (f"Price: {price}" if price is not None else "No price found")
    message_text = f"SALE ALERT!\n{display_price}"

# --- SMS Sending ---
result = {
    "success": False,
    "sent_sms": False,
    "price": price,
    "raw_text": raw_text,
    "product_name": product_name,
    "message": ""
}

try:
    if price is not None and price <= target_price and phone_number and TW_SID and TW_TOKEN:
        client = Client(TW_SID, TW_TOKEN)
        message = client.messages.create(
            body=message_text,
            from_=TW_FROM,
            to=phone_number
        )
        result["success"] = True
        result["sent_sms"] = True
        result["message"] = f"SMS sent: {message.sid}"
    else:
        if price is None:
            result["message"] = "No numeric price found; no SMS sent."
        elif not phone_number:
            result["message"] = "No phone number provided; no SMS sent."
        else:
            result["message"] = f"Price ({price}) is above target ({target_price}); no SMS sent."
        result["success"] = True
except Exception as e:
    result["success"] = False
    result["message"] = "Twilio send error: " + str(e)
    result["trace"] = traceback.format_exc()


# --- Save history ONLY if valid price ---


# Return JSON to Node.js
print(json.dumps(result))



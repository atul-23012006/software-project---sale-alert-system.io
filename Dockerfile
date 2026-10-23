FROM node:22-bookworm-slim

# Python for webscrape.py, plus Chromium + driver for its Selenium fallback
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv chromium chromium-driver fonts-liberation ca-certificates \
 && ln -s /usr/bin/chromium /usr/local/bin/google-chrome \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# lib/scraper.js picks up /app/.venv/bin/python automatically
COPY requirements.txt ./
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Render mounts Secret Files at /etc/secrets; expose a secret .env where dotenv looks for it
CMD ["sh", "-c", "[ -f /etc/secrets/.env ] && ln -sf /etc/secrets/.env /app/.env; exec npm start"]

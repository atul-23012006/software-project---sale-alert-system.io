const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Prefer the project's virtualenv (where the scraper's packages are installed);
// otherwise fall back to `python3`, since macOS / most Linux distros don't ship `python`
const VENV_PYTHON = path.join(__dirname, '..', '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const SCRIPT = path.join(__dirname, '..', 'webscrape.py');
const TIMEOUT_MS = 180 * 1000;

// Each scrape is a Python process that may launch headless Chrome (hundreds of MB), so only
// a few run at once; the rest wait in a FIFO queue. When the queue is full, new requests
// fail fast instead of piling up until the server runs out of memory.
const MAX_CONCURRENT = Math.max(1, Number(process.env.SCRAPER_CONCURRENCY) || 1);
const MAX_QUEUED = Math.max(0, Number(process.env.SCRAPER_QUEUE) || 20);
let running = 0;
const waiting = [];

function runScraper(args) {
  if (running < MAX_CONCURRENT) return runNow(args);
  if (waiting.length >= MAX_QUEUED) {
    return Promise.reject(new Error('The scraper is busy right now — please try again in a minute'));
  }
  return new Promise((resolve, reject) => waiting.push({ args, resolve, reject }));
}

function runNow(args) {
  running++;
  return spawnScraper(args).finally(() => {
    running--;
    const next = waiting.shift();
    if (next) runNow(next.args).then(next.resolve, next.reject);
  });
}

function spawnScraper(args) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON_BIN, [SCRIPT, ...args]);
    let output = '';
    let errOutput = '';
    // A hung Selenium session would otherwise block this request / cron run forever
    const timer = setTimeout(() => py.kill('SIGKILL'), TIMEOUT_MS);

    py.stdout.on('data', d => { output += d.toString(); });
    py.stderr.on('data', d => { errOutput += d.toString(); });

    // Without this, a missing python binary crashes the whole server
    py.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Could not start scraper: ${err.message}`));
    });

    py.on('close', code => {
      clearTimeout(timer);
      try {
        // The JSON result is the last line printed by webscrape.py
        resolve(JSON.parse(output.trim().split('\n').pop()));
      } catch {
        console.error(`SCRAPER FAILED (exit ${code}):`, errOutput || output);
        reject(new Error('Scraper failed to return a result'));
      }
    });
  });
}

module.exports = {
  scrapeProduct: input => runScraper(['scrape', input]),
  searchOtherStores: (name, skipSite, price) => runScraper(['compare', name, skipSite || '', price ? String(price) : '']),
};

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Prefer the project's virtualenv (where the scraper's packages are installed);
// otherwise fall back to `python3`, since macOS / most Linux distros don't ship `python`
const VENV_PYTHON = path.join(__dirname, '..', '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const SCRIPT = path.join(__dirname, '..', 'webscrape.py');
const TIMEOUT_MS = 180 * 1000;

function runScraper(args) {
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

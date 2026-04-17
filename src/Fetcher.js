const puppeteer = require('puppeteer');

class Fetcher {
  constructor(options = {}) {
    this.headless = options.headless !== undefined ? options.headless : true;
    this.browser = null;
  }

  async init() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: this.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async fetch(url) {
    await this.init();
    const page = await this.browser.newPage();

    try {
      // Phase 5 Optimization: Abort heavy resource requests
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const finalUrl = page.url();
      const html = await page.content();

      return { url: finalUrl, html };
    } catch (error) {
      console.error(`[Fetcher] Error fetching ${url}:`, error.message);
      throw error;
    } finally {
      await page.close();
    }
  }
}

module.exports = Fetcher;

import fs from 'fs';
import { PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Page } from 'playwright';

// ─── Stealth Plugin ───────────────────────────────────────────────────────────
chromium.use(stealth());

// ─── Cookies ──────────────────────────────────────────────────────────────────
const rawCookies = JSON.parse(fs.readFileSync('twitter-session.json', 'utf8'));
const savedCookies = rawCookies.map((cookie: any) => ({
  ...cookie,
  sameSite:
    cookie.sameSite === 'no_restriction' ? 'None' :
    cookie.sameSite === 'lax'            ? 'Lax'  :
    cookie.sameSite === 'strict'         ? 'Strict' : 'Lax',
}));

// ─── Keywords ─────────────────────────────────────────────────────────────────
const keywords = [
  'artificial intelligence',
  'machine learning',
  'large language models',
  'GPT',
  'deep learning',
  'neural networks',
  'natural language processing',
  'computer vision',
  'reinforcement learning',
  'transformer model',
];

// ─── Deduplication ────────────────────────────────────────────────────────────
const seenTweetIds = new Set<string>();

// ─── Tweet Extraction ─────────────────────────────────────────────────────────
async function extractTweets(page: Page, keyword: string) {
  const tweets = await page.$$eval('article', (articles) =>
    articles.map((article) => {
      const statusLink = article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
      const tweetUrl   = statusLink?.href ?? '';
      const tweetId    = tweetUrl.split('/status/')[1]?.split('/')[0] ?? '';
      const username   = (article.querySelector('[data-testid="User-Name"]') as HTMLElement)?.innerText ?? '';
      const content    = (article.querySelector('[data-testid="tweetText"]')  as HTMLElement)?.innerText ?? '';
      const time       = article.querySelector('time')?.getAttribute('datetime') ?? '';
      const replies    = (article.querySelector('[data-testid="reply"]')   as HTMLElement)?.innerText?.trim() ?? '0';
      const retweets   = (article.querySelector('[data-testid="retweet"]') as HTMLElement)?.innerText?.trim() ?? '0';
      const likes      = (article.querySelector('[data-testid="like"]')    as HTMLElement)?.innerText?.trim() ?? '0';

      return { tweetId, username, handle: tweetUrl, time, content, replies, retweets, likes };
    })
  );

  return tweets
    .filter(t => t.tweetId && !seenTweetIds.has(t.tweetId))
    .map(t => {
      seenTweetIds.add(t.tweetId);
      return { ...t, keyword };
    });
}

// ─── Adaptive Scroll ──────────────────────────────────────────────────────────
async function adaptiveScroll(page: Page, keyword: string) {
  let step = 400;
  let stableCounter = 0;
  let scrollCount = 0;

  while (stableCounter < 3) {
    const prevHeight = await page.evaluate(() => document.body.scrollHeight);

    await page.evaluate((s) => window.scrollBy(0, s), step);
    await page.waitForTimeout(1500 + Math.random() * 2000);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);

    if (newHeight > prevHeight) {
      step = Math.max(200, step - 50);
      stableCounter = 0;
    } else {
      step = Math.min(1000, step + 100);
      stableCounter++;
    }

    scrollCount++;

    // occasional human-like pauses
    if (scrollCount % 8 === 0) {
      await page.waitForTimeout(5000 + Math.random() * 5000);
    }

    // slight random scroll variation
    if (Math.random() < 0.3) {
      await page.mouse.wheel(0, 200 + Math.random() * 300);
    }

    // snapshot saving
    if (scrollCount % 20 === 0) {
      const snapshot = await extractTweets(page, keyword);
      if (snapshot.length > 0) {
        const dataset = await Dataset.open(keyword);
        await dataset.pushData(snapshot);
        console.log(`💾 Snapshot saved: ${snapshot.length} tweets for "${keyword}"`);
      }
    }

    // cooldown
    if (scrollCount % 25 === 0) {
      console.log(`💤 Cooldown at scroll ${scrollCount}`);
      await page.waitForTimeout(60000 + Math.random() * 60000);
    }
  }
}

// ─── Request Queue ────────────────────────────────────────────────────────────
const requestQueue = await RequestQueue.open();

for (const keyword of keywords) {
  await requestQueue.addRequest({
    url: `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`,
    label: keyword,
  });
}

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler ({
  requestQueue,

  maxConcurrency: 1, // 🔥 VERY IMPORTANT
  useSessionPool: true,
  persistCookiesPerSession: true,

  requestHandlerTimeoutSecs: 3600,
  maxRequestRetries: 3,

  launchContext: {
    launcher: chromium,
    launchOptions: {
      headless: true,
      channel: "chrome",
      args: [
        "--headless=new",
        "--disable-blink-features=AutomationControlled",
      ],
    },
  },

  async requestHandler({ page, request }) {
    const keyword = request.label ?? 'unknown';
    console.log(`🔍 Crawling: "${keyword}"`)

    const context = page.context();
  

    // ─── Stealth Patches ───
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4],
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // @ts-ignore
      window.chrome = { runtime: {} };

      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({
              state: Notification.permission,
              onchange: null,
            } as PermissionStatus)
          : originalQuery(parameters);
    });
    // ─── Realistic viewport ───
    await page.setViewportSize({
      width: 1366 + Math.floor(Math.random() * 100),
      height: 768 + Math.floor(Math.random() * 100),
    })

    // ─── Apply cookies BEFORE navigation ───
    await context.addCookies(savedCookies);

    // ─── Human delay before navigation ───
    await page.waitForTimeout(2000 + Math.random() * 3000);

    await page.goto(request.url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // ─── Wake up page (important for headless) ───
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(3000);

    await page.waitForSelector('article', { timeout: 15000 });

    await page.waitForSelector('article', { timeout: 30000 });

    console.log(`✅ Loaded: "${keyword}"`);

    // ─── Start scrolling ───
    await adaptiveScroll(page, keyword);

    // ─── Final extraction ───
    const tweets = await extractTweets(page, keyword);

    if (tweets.length > 0) {
      const dataset = await Dataset.open(keyword);
      await dataset.pushData(tweets);
    }

    console.log(`✅ Done "${keyword}" — Total tweets: ${seenTweetIds.size}`);

    // ─── Cooldown between keywords ───
    await page.waitForTimeout(15000 + Math.random() * 15000);
  }
});

await crawler.run();

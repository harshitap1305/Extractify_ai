/**
 * test-twitter-debug.js  —  verifies the new API-capture approach
 * Run: node test-twitter-debug.js
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const path      = require('path');

async function debug() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
        defaultViewport: { width: 1280, height: 900 },
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

    // Stealth — must run before any navigation
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
        Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        delete navigator.__proto__.webdriver;
    });

    // Load cookies
    const raw = process.env.TWITTER_COOKIES;
    if (!raw) { console.error('TWITTER_COOKIES not set'); process.exit(1); }
    const cookies = JSON.parse(raw);
    const normalised = [];
    for (const c of cookies) {
        const base = { name: c.name || '', value: c.value || '', path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'None' };
        if (c.expirationDate) base.expires = c.expirationDate;
        normalised.push({ ...base, domain: '.x.com' }, { ...base, domain: '.twitter.com' });
    }

    await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.setCookie(...normalised);
    console.log(`Set ${normalised.length} cookies`);

    // ── Set up response capture BEFORE navigation ─────────────────────────────
    let capturedJson = null;
    let capturedUrl  = null;

    const isTarget = (url) => (
        url.includes('/UserTweets') || url.includes('/HomeTimeline') ||
        url.includes('/SearchTimeline') || url.includes('/TweetDetail')
    );

    page.on('response', async (response) => {
        if (capturedJson !== null) return;
        if (!isTarget(response.url())) return;
        if (!response.ok()) return;
        try {
            const text = await response.text();
            capturedJson = JSON.parse(text);
            capturedUrl  = response.url();
            console.log(`\n✅ API captured: ${response.url().split('?')[0]}`);
        } catch (e) {
            console.log('Parse error:', e.message);
        }
    });

    // ── Navigate ──────────────────────────────────────────────────────────────
    const target = 'https://x.com/elonmusk';
    console.log(`\nNavigating to ${target}...`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.waitForSelector('[data-testid="primaryColumn"], [data-testid="loginButton"]', { timeout: 30000 })
        .then(() => console.log('✅ primaryColumn appeared'))
        .catch(() => console.log('⚠️  primaryColumn timeout (30s)'));

    // Poll for captured JSON
    console.log('Waiting for UserTweets API response (max 45s)...');
    const deadline = Date.now() + 45000;
    while (capturedJson === null && Date.now() < deadline) {
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('');

    if (capturedJson) {
        // ── Parse tweets from API JSON ────────────────────────────────────────
        const { parseTweetsFromGraphQL } = require('./src/TwitterScraper.js');
        // Since parseTweetsFromGraphQL is not exported, replicate minimal version:
        const tweets = [];
        const seen   = new Set();
        function walk(node) {
            if (!node || typeof node !== 'object') return;
            const t = (node.__typename === 'TweetWithVisibilityResults' && node.tweet) ? node.tweet : node;
            if (t.legacy && t.legacy.id_str && t.core && !seen.has(t.legacy.id_str)) {
                seen.add(t.legacy.id_str);
                const u = t.core?.user_results?.result?.legacy || {};
                tweets.push({ handle: u.screen_name || 'unknown', text: (t.legacy.full_text || '').substring(0, 80) + '...', likes: t.legacy.favorite_count || 0 });
            }
            if (Array.isArray(node)) for (const i of node) walk(i);
            else for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
        }
        walk(capturedJson);

        console.log(`\n═══ PARSED ${tweets.length} TWEETS FROM API ═══`);
        tweets.slice(0, 5).forEach((t, i) => {
            console.log(`\n[${i+1}] @${t.handle} (${t.likes} likes)`);
            console.log(`    ${t.text}`);
        });

        console.log('\n═══ RAW API SAMPLE (first 1500 chars) ═══');
        console.log(JSON.stringify(capturedJson).substring(0, 1500));
    } else {
        console.log('\n❌ No UserTweets API response captured within 45s');
        console.log('This might mean the request never fired OR capture failed.');
    }

    // ── DOM diagnostics ───────────────────────────────────────────────────────
    const d = await page.evaluate(() => ({
        title:            document.title,
        hasPrimaryColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
        hasLoginButton:   !!document.querySelector('[data-testid="loginButton"]'),
        tweetDomCount:    document.querySelectorAll('[data-testid="tweet"]').length,
    }));
    console.log('\n═══ DOM DIAGNOSTICS ═══');
    console.log(JSON.stringify(d, null, 2));

    await page.screenshot({ path: path.join(__dirname, 'twitter-debug.png'), fullPage: false });
    console.log('\nScreenshot saved → twitter-debug.png');

    await browser.close();
}

debug().catch(e => { console.error(e.message); process.exit(1); });

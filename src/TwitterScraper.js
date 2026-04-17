'use strict';

/**
 * TwitterScraper.js
 *
 * Production-grade hybrid scraper:
 *   1. Puppeteer for authenticated browser session
 *   2. page.on('response') captures GraphQL API responses immediately
 *   3. Scroll-based pagination — each scroll triggers a new API call with the
 *      next cursor, collecting additional tweet batches
 *   4. Rate-limiter + browser-restart support for long (24h+) runs
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const https = require('https');

// Twitter's public Bearer token — embedded in their JS bundle, same for every client
const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I6xF5kyAAA%3DQpBFiZlSJeGa2D56kR4cqE4mFcvGOjBiN0VX2_nFCgFHvJfpE';

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function loadCookiesFromEnv() {
    const raw = process.env.TWITTER_COOKIES;
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { console.error('[TwitterScraper] TWITTER_COOKIES is invalid JSON:', e.message); return []; }

    const normalised = [];
    for (const c of parsed) {
        const base = {
            name: c.name || '',
            value: c.value || '',
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'None',
        };
        if (c.expires !== undefined) base.expires = c.expires;
        else if (c.expirationDate !== undefined) base.expires = c.expirationDate;
        normalised.push({ ...base, domain: '.twitter.com' });
        normalised.push({ ...base, domain: '.x.com' });
    }
    return normalised;
}

// ─── URL classifier ───────────────────────────────────────────────────────────

function classifyUrl(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length === 0 || parts[0] === 'home') return { type: 'home' };
        if (parts.length >= 2 && parts[1] === 'status') return { type: 'tweet', username: parts[0], tweetId: parts[2] };
        if (u.pathname.startsWith('/search')) return { type: 'search', query: u.searchParams.get('q') };
        const skip = new Set(['explore', 'notifications', 'messages', 'i', 'settings', 'compose']);
        if (parts.length >= 1 && !skip.has(parts[0])) return { type: 'profile', username: parts[0] };
    } catch (_) { }
    return { type: 'unknown' };
}

// ─── GraphQL JSON → tweet objects ─────────────────────────────────────────────
// Recursively walks the response tree; resilient to schema changes.

function parseTweetsFromGraphQL(json, sourceUrl, depth) {
    const tweets = [];
    const seenIds = new Set();

    function walk(node) {
        if (!node || typeof node !== 'object') return;

        const tweetNode = (node.__typename === 'TweetWithVisibilityResults' && node.tweet) ? node.tweet : node;

        if (tweetNode.legacy && tweetNode.legacy.id_str && tweetNode.core) {
            const legacy = tweetNode.legacy;
            const id = legacy.id_str;
            if (!seenIds.has(id)) {
                seenIds.add(id);

                // X puts screen_name/name in either .legacy or .core depending on API version
                const userResult = tweetNode.core?.user_results?.result || {};
                const userLegacy = userResult.legacy || {};
                const userCore = userResult.core || {};
                const screenName = userLegacy.screen_name || userCore.screen_name || '';
                const displayName = userLegacy.name || userCore.name || '';

                const mediaSet = new Set([
                    ...(legacy.entities?.media || []).map(m => m.media_url_https),
                    ...(legacy.extended_entities?.media || []).map(m => m.media_url_https),
                ]);

                let quoteTweet = '';
                if (legacy.is_quote_status) {
                    const qr = tweetNode.quoted_status_result?.result;
                    const qn = qr?.__typename === 'TweetWithVisibilityResults' ? qr.tweet : qr;
                    quoteTweet = qn?.legacy?.full_text || '';
                }

                tweets.push({
                    tweetUrl: screenName ? `https://x.com/${screenName}/status/${id}` : '',
                    sourceUrl,
                    depth,
                    handle: screenName,
                    displayName,
                    postedAt: legacy.created_at || '',
                    text: legacy.full_text || legacy.text || '',
                    lang: legacy.lang || '',
                    stats: {
                        like: Number(legacy.favorite_count) || 0,
                        retweet: Number(legacy.retweet_count) || 0,
                        reply: Number(legacy.reply_count) || 0,
                        views: Number(tweetNode.views?.count) || 0,
                        bookmarks: Number(legacy.bookmark_count) || 0,
                    },
                    media: [...mediaSet],
                    quoteTweet,
                    isRetweet: !!legacy.retweeted_status_result,
                });
            }
        }

        if (Array.isArray(node)) {
            for (const item of node) walk(item);
        } else {
            for (const val of Object.values(node)) {
                if (val && typeof val === 'object') walk(val);
            }
        }
    }

    try { walk(json); } catch (_) { }
    return tweets;
}

// ─── Extract pagination cursor ────────────────────────────────────────────────
// Twitter includes a cursor-bottom entry in every timeline API response.
// We use it to request the next page directly via fetch().

function extractBottomCursor(json) {
    let cursor = null;
    function walk(node) {
        if (!node || typeof node !== 'object' || cursor) return;
        if (node.entryType === 'TimelineTimelineCursor' && node.cursorType === 'Bottom') {
            cursor = node.value;
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) { walk(item); if (cursor) return; }
        } else {
            for (const val of Object.values(node)) {
                if (val && typeof val === 'object') { walk(val); if (cursor) return; }
            }
        }
    }
    try { walk(json); } catch (_) { }
    return cursor;
}

// ─── Main Class ───────────────────────────────────────────────────────────────

class TwitterScraper {
    /**
     * @param {object} config
     * @param {number} config.scrollRounds    - Scroll rounds per URL (default 8)
     * @param {number} config.scrollPauseMs   - Pause between scrolls in ms (default 2000)
     * @param {number} config.navTimeout      - Navigation timeout in ms (default 60000)
     * @param {number} config.maxTweetsPerUrl - Stop scrolling after collecting this many tweets per URL (default 200)
     * @param {number} config.cooldownMs      - Delay between URL visits to avoid rate limits (default 3000)
     * @param {number} config.maxDurationMs   - Hard stop after this many ms (0 = no limit)
     * @param {number} config.browserRestartEvery - Restart browser every N URLs to free memory (default 50)
     */
    constructor(config = {}) {
        this.scrollRounds = config.scrollRounds ?? 8;
        this.scrollPauseMs = config.scrollPauseMs ?? 2000;
        this.navTimeout = config.navTimeout ?? 60000;
        this.maxTweetsPerUrl = config.maxTweetsPerUrl ?? 200;
        this.cooldownMs = config.cooldownMs ?? 3000;
        this.maxDurationMs = config.maxDurationMs ?? 0;
        this.browserRestartEvery = config.browserRestartEvery ?? 50;
        this._isCancelled = config.isCancelled || (() => false);
        this.browser = null;
        this.page = null;
        this._urlsVisited = 0;
        this._startTime = null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        this._startTime = this._startTime || Date.now();
        await this._launchBrowser();
    }

    async _launchBrowser() {
        if (this.browser) await this.browser.close().catch(() => { });

        this.browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,900',
                '--disable-dev-shm-usage',
            ],
            defaultViewport: { width: 1280, height: 900 },
        });

        this.page = await this.browser.newPage();
        this._liveCookies = null;  // will be populated after first navigation

        await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        );

        // Stealth — must be applied before any navigation
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {}, loadTimes: () => { }, csi: () => { }, app: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            delete navigator.__proto__.webdriver;
        });

        // Domain context needed before setting cookies
        await this.page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });

        const cookies = loadCookiesFromEnv();
        if (cookies.length === 0) throw new Error('No cookies found. Set TWITTER_COOKIES in .env');
        await this.page.setCookie(...cookies);

        // Reload with cookies active — Twitter may refresh ct0 here
        await this.page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        await this._sleep(2000);
        // Snapshot the live session cookies (inc. any refreshed ct0)
        await this._snapshotCookies();
    }

    async _snapshotCookies() {
        try {
            this._liveCookies = await this.page.cookies();
        } catch (_) { }
    }

    async close() {
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
            this.page = null;
        }
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    _isTimedOut() {
        if (!this.maxDurationMs || !this._startTime) return false;
        return (Date.now() - this._startTime) >= this.maxDurationMs;
    }

    _isStopped() {
        return this._isTimedOut() || this._isCancelled();
    }

    // ── Core: navigate + cursor-based pagination ──────────────────────────────
    //
    // Scroll-based pagination does NOT work in headless Chrome with Twitter because
    // the virtual list never mounts (tweetDomCount always 0), so IntersectionObserver
    // never fires, and Twitter never makes a second API call from scrolling.
    // Instead we:
    //   1. Capture the first API response body + its request URL via page.on('response')
    //   2. Extract the bottom cursor from the response JSON
    //   3. Call the same API endpoint via page.evaluate(fetch()) with cursor injected
    //      into the variables — exactly what Twitter's own JS does internally
    //   4. Repeat until maxTweetsPerUrl, stopped, or cursor exhausted

    async _navigateAndCollect(url, sourceUrl, depth, globalSeen, onProgress) {
        const batchTweets = [];
        let capturedApiUrl = null;   // full URL of first matched API call (for cursor pagination)
        let firstApiJson = null;   // parsed JSON from first API call

        const isTargetResp = (u) => (
            u.includes('/UserTweets') ||
            u.includes('/UserTweetsAndReplies') ||
            u.includes('/HomeTimeline') ||
            u.includes('/SearchTimeline') ||
            u.includes('/TweetDetail')
        );

        const responseHandler = async (response) => {
            if (!isTargetResp(response.url())) return;
            if (!response.ok()) return;
            try {
                const text = await response.text();
                const json = JSON.parse(text);

                // Store the first matching API URL & JSON for cursor pagination
                if (!capturedApiUrl) {
                    capturedApiUrl = response.url();
                    firstApiJson = json;
                }

                const tweets = parseTweetsFromGraphQL(json, sourceUrl || url, depth);
                for (const t of tweets) {
                    if (t.tweetUrl && !globalSeen.has(t.tweetUrl)) {
                        globalSeen.add(t.tweetUrl);
                        batchTweets.push(t);
                    }
                }
            } catch (_) { }
        };

        this.page.on('response', responseHandler);

        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeout });

            await this.page.waitForSelector(
                '[data-testid="primaryColumn"], [data-testid="loginButton"]',
                { timeout: 30000 }
            ).catch(() => { });

            // Wake up page (important for headless lazy loading)
            await this.page.mouse.wheel({ deltaY: 500 });
            await this._sleep(3000);

            // Poll until first API response arrives (max 45s)
            const initDeadline = Date.now() + 45000;
            while (!firstApiJson && Date.now() < initDeadline) {
                await this._sleep(500);
            }

            if (!firstApiJson) {
                onProgress && onProgress(`No API response received for ${url}`);
                return batchTweets;
            }

            onProgress && onProgress(`Page 1: ${batchTweets.length} tweets — starting native scroll pagination...`);

            // ── Adaptive Scroll Pagination (triggers native Next Page API fetch) ──
            let step = 400;
            let stableCounter = 0;
            let scrollCount = 0;

            while (!this._isStopped() && batchTweets.length < this.maxTweetsPerUrl && stableCounter < 15) {
                const prevLength = batchTweets.length;

                await this.page.evaluate((s) => window.scrollBy(0, s), step);
                await this._sleep(1500 + Math.random() * 2000);

                scrollCount++;

                // Occasional human-like pauses
                if (scrollCount % 8 === 0) {
                    await this._sleep(5000 + Math.random() * 5000);
                }

                // Slight random scroll variation using the wheel
                if (Math.random() < 0.3) {
                    await this.page.mouse.wheel({ deltaY: 200 + Math.random() * 300 });
                }

                if (batchTweets.length > prevLength) {
                    onProgress && onProgress(`Scroll ${scrollCount}: +${batchTweets.length - prevLength} tweets (total: ${batchTweets.length})`);
                    step = Math.max(200, step - 50);
                    stableCounter = 0; // reset, we got data!
                } else {
                    step = Math.min(1200, step + 150);
                    stableCounter++; // no data, increment failure counter
                }

                // Cooldown burst protection
                if (scrollCount > 0 && scrollCount % 25 === 0) {
                    onProgress && onProgress(`💤 Cooldown at scroll ${scrollCount}...`);
                    await this._sleep(30000 + Math.random() * 30000);
                }
            }

            // Exited the loop — report why
            if (this._isStopped()) {
                onProgress && onProgress(`Pagination stopped (job cancelled or timed out)`);
            } else if (batchTweets.length >= this.maxTweetsPerUrl) {
                onProgress && onProgress(`Pagination stopped (reached max limit of ${this.maxTweetsPerUrl})`);
            } else if (stableCounter >= 15) {
                onProgress && onProgress(`Pagination stopped (no new tweets loaded after 15 consecutive scrolls)`);
            }

        } finally {
            this.page.off('response', responseHandler);
        }

        return batchTweets;
    }



    /**
     * @param {string}   seedUrl    - Starting URL
     * @param {number}   maxDepth   - Max link-following depth
     * @param {Function} onProgress - Progress callback(message)
     * @returns {Promise<object[]>} - Array of tweet objects
     */
    async scrape(seedUrl, maxDepth, onProgress) {
        this._startTime = this._startTime || Date.now();
        const allTweets = [];
        const visited = new Set();
        const globalSeen = new Set();  // dedup across all URLs
        maxDepth = Math.min(maxDepth || 1, 5);

        const log = (msg) => onProgress && onProgress(msg);

        const scrapeUrl = async (url, depth) => {
            if (visited.has(url) || depth > maxDepth) return;
            if (this._isStopped()) { log('Stopped — exiting'); return; }
            visited.add(url);

            // Periodic browser restart for long runs
            this._urlsVisited++;
            if (this._urlsVisited > 1 && this._urlsVisited % this.browserRestartEvery === 0) {
                log(`[Memory] Restarting browser after ${this._urlsVisited} URLs...`);
                await this._launchBrowser();
            }

            const urlType = classifyUrl(url);
            log(`[Depth ${depth}/${maxDepth}] Navigating to ${urlType.type}: ${url}`);

            try {
                const tweets = await this._navigateAndCollect(url, url, depth, globalSeen, log);

                // Login wall check
                const isLoggedIn = await this.page.evaluate(
                    () => !document.querySelector('[data-testid="loginButton"]')
                );
                if (!isLoggedIn) throw new Error('Login wall — cookies may be expired');

                allTweets.push(...tweets);
                log(`[Depth ${depth}/${maxDepth}] Collected ${tweets.length} tweet(s) from ${url} (total: ${allTweets.length})`);

                // Polite cooldown between requests
                if (this.cooldownMs > 0) await this._sleep(this.cooldownMs);

                // Depth expansion (deep crawling)
                if (depth < maxDepth && !this._isTimedOut()) {
                    let subLinks = new Set();
                    
                    if (['home', 'search'].includes(urlType.type)) {
                        // From home/search, let's explore the user PROFILES we just saw
                        for (const t of tweets) {
                            if (t.handle) subLinks.add(`https://x.com/${t.handle}`);
                        }
                    } else if (urlType.type === 'profile') {
                        // From a profile, let's explore their specific TWEET THREADS
                        for (const t of tweets) {
                            if (t.tweetUrl) subLinks.add(t.tweetUrl);
                        }
                    } else if (urlType.type === 'tweet') {
                        // From a tweet thread, let's explore the commenters' PROFILES
                        for (const t of tweets) {
                            if (t.handle) subLinks.add(`https://x.com/${t.handle}`);
                        }
                    }

                    const linksArray = [...subLinks].slice(0, 50); // limit fan-out to prevent explosion
                    log(`[Depth ${depth}] Expanding crawl to ${linksArray.length} new URLs based on discovered data...`);
                    
                    for (const link of linksArray) {
                        if (this._isTimedOut()) break;
                        await scrapeUrl(link, depth + 1);
                    }
                }

            } catch (err) {
                if (err.message.includes('Login wall') || err.message.includes('cookies may be expired')) throw err;
                log(`[Depth ${depth}/${maxDepth}] SKIPPED ${url} — ${err.message}`);
            }
        };

        await scrapeUrl(seedUrl, 1);

        const elapsed = Math.round((Date.now() - this._startTime) / 1000);
        log(`Scraping complete. ${allTweets.length} unique tweets in ${elapsed}s (${Math.round(allTweets.length / elapsed * 60)}/min)`);
        return allTweets;
    }
}

module.exports = TwitterScraper;

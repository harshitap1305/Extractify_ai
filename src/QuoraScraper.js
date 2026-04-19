'use strict';

/**
 * QuoraScraper.js
 *
 * Production-grade hybrid scraper:
 *   1. Puppeteer for authenticated browser session via QUORA_COOKIES
 *   2. Scroll-based traversal triggering the lazy-loaded answers/posts
 *   3. Extracting content repeatedly from the DOM tree
 */

require('dotenv').config();
const puppeteer = require('puppeteer');

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function loadCookiesFromEnv() {
    const raw = process.env.QUORA_COOKIES;
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { console.error('[QuoraScraper] QUORA_COOKIES is invalid JSON:', e.message); return []; }

    const normalised = [];
    for (const c of parsed) {
        const base = {
            name: c.name || '',
            value: c.value || '',
            domain: c.domain || '.quora.com',
            path: c.path || '/',
            secure: true,
            httpOnly: !!c.httpOnly,
            sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'None',
        };
        if (c.expires !== undefined) base.expires = c.expires;
        else if (c.expirationDate !== undefined) base.expires = c.expirationDate;

        normalised.push(base);
    }
    return normalised;
}

// ─── Main Class ───────────────────────────────────────────────────────────────

class QuoraScraper {
    constructor(config = {}) {
        this.navTimeout = config.navTimeout ?? 60000;
        this.maxPostsPerUrl = config.maxPostsPerUrl ?? 200;
        this.cooldownMs = config.cooldownMs ?? 3000;
        this.maxDurationMs = config.maxDurationMs ?? 0;
        this.browserRestartEvery = config.browserRestartEvery ?? 50;
        this._isCancelled = config.isCancelled || (() => false);
        this.browser = null;
        this.page = null;
        this._urlsVisited = 0;
        this._startTime = null;
    }

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
                '--window-size=1280,1024',
                '--disable-dev-shm-usage',
            ],
            defaultViewport: { width: 1280, height: 1024 },
        });

        this.page = await this.browser.newPage();

        await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        );

        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Domain context needed before setting cookies
        await this.page.goto('https://www.quora.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });

        const cookies = loadCookiesFromEnv();
        if (cookies.length === 0) throw new Error('No cookies found. Set QUORA_COOKIES in .env');
        await this.page.setCookie(...cookies);

        // Reload to apply authenticated session
        await this.page.goto('https://www.quora.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        await this._sleep(3000); // Allow react rendering
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

    async _navigateAndCollectDOM(url, sourceUrl, depth, globalSeen, onProgress) {
        let batchPosts = [];

        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeout });

            // Ensure "More" buttons are clicked if answers are truncated
            const expandMoreButtons = async () => {
                const buttons = await this.page.$$('.q-box.qu-cursor--pointer.qu-color--blue_dark.qu-whiteSpace--nowrap'); // (More)
                for (let b of buttons) {
                    try { await b.click(); } catch(e) {}
                }
            };

            await this._sleep(4000);
            onProgress && onProgress(`Starting evaluation of DOM for page 1...`);

            let step = 600;
            let stableCounter = 0;
            let scrollCount = 0;

            while (!this._isStopped() && batchPosts.length < this.maxPostsPerUrl && stableCounter < 15) {
                const prevLength = batchPosts.length;

                await expandMoreButtons();

                // Evaluate the DOM tree to extract the posts currently visible.
                const newPosts = await this.page.evaluate((d, sUrl) => {
                    const extracted = [];
                    // Look for common wrapper elements containing answer text
                    const answerNodes = document.querySelectorAll('.spacing_log_answer_content, .q-box.qu-wordBreak--break-word, .q-text.qu-wordBreak--break-word');

                    for (let contentEl of answerNodes) {
                        try {
                            const content = contentEl.innerText.trim();
                            if (content.length < 10) continue; // Skip tiny fragments

                            // Traverse up to find a common wrapper block (max 10 levels)
                            let wrapper = contentEl.parentElement;
                            for (let i = 0; i < 10; i++) {
                                if (!wrapper) break;
                                if (wrapper.innerText.includes('Upvote') || wrapper.querySelector('a[href*="/profile/"]')) {
                                    break;
                                }
                                wrapper = wrapper.parentElement;
                            }
                            if (!wrapper) wrapper = contentEl.parentElement;

                            // Author
                            const authorEl = wrapper.querySelector('a[href*="/profile/"], .q-text.qu-bold');
                            const author = authorEl ? authorEl.innerText.trim() : 'Unknown User';

                            // Title
                            const titleEl = wrapper.querySelector('a[href*="/"] > span.q-text.qu-bold, .q-text.qu-bold.qu-display--inline, h1, h2');
                            const title = titleEl ? titleEl.innerText.trim() : '';

                            // Upvotes
                            const upvotesMatch = wrapper.innerText.match(/(\d+(?:\.\d+)?[KM]?)\s*Upvotes?/i);
                            const upvotes = upvotesMatch ? upvotesMatch[1] : '0';

                            // Deduplication signature
                            const sig = btoa(unescape(encodeURIComponent((author + content).substring(0, 50))));
                            extracted.push({
                                url: sUrl + '#' + sig,
                                sourceUrl: sUrl,
                                depth: d,
                                author: author,
                                title: title,
                                content: content,
                                upvotes: upvotes
                            });
                        } catch (e) {}
                    }
                    return extracted;
                }, depth, sourceUrl);

                for (let p of newPosts) {
                    if (p.url && !globalSeen.has(p.url)) {
                        globalSeen.add(p.url);
                        batchPosts.push(p);
                    }
                }

                await this.page.evaluate((s) => window.scrollBy(0, s), step);
                await this._sleep(1500 + Math.random() * 2000);
                scrollCount++;

                if (batchPosts.length > prevLength) {
                    onProgress && onProgress(`Scroll ${scrollCount}: +${batchPosts.length - prevLength} posts (total: ${batchPosts.length})`);
                    step = Math.max(300, step - 50);
                    stableCounter = 0;
                } else {
                    step = Math.min(1500, step + 200);
                    stableCounter++;
                }

                if (scrollCount > 0 && scrollCount % 20 === 0) {
                    onProgress && onProgress(`💤 Cooldown at scroll ${scrollCount}...`);
                    await this._sleep(15000 + Math.random() * 10000);
                }
            }

            if (this._isStopped()) {
                onProgress && onProgress(`Pagination stopped (job cancelled or timed out)`);
            } else if (batchPosts.length >= this.maxPostsPerUrl) {
                onProgress && onProgress(`Pagination stopped (reached max limit of ${this.maxPostsPerUrl})`);
            } else if (stableCounter >= 15) {
                onProgress && onProgress(`Pagination stopped (no new posts loaded after 15 consecutive scrolls)`);
            }

        } catch (e) {
            onProgress && onProgress(`Error processing DOM: ${e.message}`);
        }

        return batchPosts;
    }


    /**
     * @param {string}   seedUrl    - Starting URL
     * @param {number}   maxDepth   - Max link-following depth
     * @param {Function} onProgress - Progress callback(message)
     * @returns {Promise<object[]>} - Array of post objects
     */
    async scrape(seedUrl, maxDepth, onProgress) {
        this._startTime = this._startTime || Date.now();
        const allPosts = [];
        const visited = new Set();
        const globalSeen = new Set();
        maxDepth = Math.min(maxDepth || 1, 5);

        const log = (msg) => onProgress && onProgress(msg);

        const scrapeUrl = async (url, depth) => {
            if (visited.has(url) || depth > maxDepth) return;
            if (this._isStopped()) { log('Stopped — exiting'); return; }
            visited.add(url);

            this._urlsVisited++;
            if (this._urlsVisited > 1 && this._urlsVisited % this.browserRestartEvery === 0) {
                log(`[Memory] Restarting browser after ${this._urlsVisited} URLs...`);
                await this._launchBrowser();
            }

            log(`[Depth ${depth}/${maxDepth}] Navigating to: ${url}`);

            try {
                const posts = await this._navigateAndCollectDOM(url, url, depth, globalSeen, log);

                const isLoggedIn = await this.page.evaluate(() => {
                    const el = document.body.innerText;
                    return !(el.includes('Sign in to Quora') && el.includes('Continue with Google')) && !document.querySelector('form[action*="login"]');
                });
                if (!isLoggedIn) throw new Error('Login wall — cookies may be expired');

                allPosts.push(...posts);
                log(`[Depth ${depth}/${maxDepth}] Collected ${posts.length} post(s) from ${url} (total: ${allPosts.length})`);

                if (this.cooldownMs > 0) await this._sleep(this.cooldownMs);

                // Deep crawl feature - extract hrefs from related questions
                if (depth < maxDepth && !this._isTimedOut()) {
                    let subLinks = new Set();

                    const discoveredLinks = await this.page.evaluate(() => {
                        let links = [];
                        // grab related questions links if present
                        document.querySelectorAll('a[href*="/"]').forEach(a => {
                            if (a.href && !a.href.includes('profile') && !a.href.includes('q=') && a.href.includes('quora.com')) {
                                links.push(a.href);
                            }
                        });
                        return links;
                    });

                    discoveredLinks.forEach(l => subLinks.add(l));

                    const linksArray = [...subLinks].slice(0, 15); // Strict limit to prevent explosion
                    log(`[Depth ${depth}] Expanding crawl to ${linksArray.length} new related question URLs...`);
                    
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
        log(`Scraping complete. ${allPosts.length} unique posts in ${elapsed}s`);
        return allPosts;
    }
}

module.exports = QuoraScraper;

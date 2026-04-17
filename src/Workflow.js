const { PuppeteerCrawler, CheerioCrawler, RequestQueue } = require('crawlee');
const Cleaner = require('./Cleaner');
const db = require('./Database');

class Workflow {
    constructor(extractor) {
        this.extractor = extractor;
    }

    async runJob(startUrl, prompt, maxDepth, fastMode, aiFreeMode, jobId, onProgress) {
        onProgress({ status: 'initializing', message: 'Starting Crawlee Autoscaled Pool...' });

        // Using Crawlee's built-in queue memory manages deduplication
        const requestQueue = await RequestQueue.open();

        // Clear out old data if we use default queue
        await requestQueue.drop();
        const cleanQueue = await RequestQueue.open();

        await cleanQueue.addRequest({ url: startUrl, userData: { depth: 1 } });

        const crawlerOptions = {
            requestQueue: cleanQueue,
            maxRequestsPerCrawl: 100, // safety cap
            maxConcurrency: 10, // Massive concurrency limit to allow full CPU saturation
            requestHandler: async ({ page, request, enqueueLinks, $ }) => {
                const { url } = request;
                const { depth } = request.userData;

                onProgress({ status: 'fetching', message: `[Depth ${depth}/${maxDepth}] Browsing ${url}` });

                onProgress({ status: 'cleaning', message: `[Depth ${depth}/${maxDepth}] Scrubbing DOM structure...` });

                let html;

                if (page) {
                    // Auto-scroll to trigger any lazy-loaded dynamically fetched paragraphs
                    await page.evaluate(async () => {
                        await new Promise((resolve) => {
                            let totalHeight = 0;
                            const distance = 500;
                            const timer = setInterval(() => {
                                const scrollHeight = document.body.scrollHeight;
                                window.scrollBy(0, distance);
                                totalHeight += distance;
                                // Cap off scrolling at ~8000 pixels or document bottom to avoid infinite live-blog traps
                                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 8000) {
                                    clearInterval(timer);
                                    resolve();
                                }
                            }, 100);
                        });
                    });
                    html = await page.content();
                } else if ($) {
                    // Fast static mode utilizing blazing HTML retrieval
                    html = $.html();
                }

                const cleanedData = Cleaner.clean(html, url);
                const safeText = cleanedData.raw_text.substring(0, 250000); // Increased 10x for massive document full-text parsing

                if (aiFreeMode) {
                    onProgress({ status: 'extracting', message: `[Depth ${depth}/${maxDepth}] AI-Free Bypass: Scraping structured news...` });
                    try {
                        const deterministicExtraction = { title: cleanedData.title, date: cleanedData.date, body: cleanedData.body };
                        const stmt = db.prepare('INSERT INTO results (job_id, url, depth, raw_text, extracted_json) VALUES (?, ?, ?, ?, ?)');
                        stmt.run(jobId, url, depth, safeText, JSON.stringify(deterministicExtraction));
                        onProgress({ status: 'completed', message: `[Depth ${depth}/${maxDepth}] Deterministic extracted data saved.` });
                    } catch (error) {
                        const stmt = db.prepare('INSERT INTO results (job_id, url, depth, raw_text, error) VALUES (?, ?, ?, ?, ?)');
                        stmt.run(jobId, url, depth, safeText, `Scraper Error: ${error.message}`);
                        onProgress({ status: 'error', message: `[Depth ${depth}/${maxDepth}] System Error: Skipping extraction. Saved raw_text.` });
                    }
                } else {
                    onProgress({ status: 'extracting', message: `[Depth ${depth}/${maxDepth}] Querying AI Model for ${url}` });

                    try {
                        const extracted = await this.extractor.extract(prompt, safeText);
                        const stmt = db.prepare('INSERT INTO results (job_id, url, depth, raw_text, extracted_json) VALUES (?, ?, ?, ?, ?)');
                        stmt.run(jobId, url, depth, safeText, JSON.stringify(extracted));

                        onProgress({ status: 'completed', message: `[Depth ${depth}/${maxDepth}] Extracted data successfully.` });
                    } catch (error) {
                        // Fallback to storing raw_text exclusively if AI runs out of retries
                        const stmt = db.prepare('INSERT INTO results (job_id, url, depth, raw_text, error) VALUES (?, ?, ?, ?, ?)');
                        stmt.run(jobId, url, depth, safeText, `AI Error: ${error.message}`);

                        onProgress({ status: 'error', message: `[Depth ${depth}/${maxDepth}] AI Error: Skipping extraction. Saved raw_text.` });
                    }
                }

                if (depth < maxDepth) {
                    onProgress({ status: 'crawling', message: `[Depth ${depth}] Enqueuing sub-links utilizing Crawlee...` });
                    // Crawlee automatically handles duplicate queue rejection and relative URL resolution
                    await enqueueLinks({
                        strategy: 'same-domain',
                        selector: 'a:not(footer a, .footer a, [class*="footer"] a, [id*="footer"] a)',
                        userData: { depth: depth + 1 }
                    });
                }
            },
            failedRequestHandler({ request, error }) {
                onProgress({ status: 'error', message: `Request to ${request.url} failed: ${error.message}` });
            }
        };

        let crawler;
        if (fastMode) {
            onProgress({ status: 'initializing', message: 'Engine: Fast Mode (CheerioCrawler)' });
            crawlerOptions.preNavigationHooks = [
                ({ request }) => {
                    request.headers = {
                        ...request.headers,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Upgrade-Insecure-Requests': '1',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none'
                    };
                }
            ];
            crawler = new CheerioCrawler(crawlerOptions);
        } else {
            onProgress({ status: 'initializing', message: 'Engine: Deep Mode (PuppeteerCrawler)' });
            crawlerOptions.launchContext = {
                launchOptions: {
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            };
            crawlerOptions.preNavigationHooks = [
                async ({ page }) => {
                    await page.setRequestInterception(true);
                    page.on('request', (req) => {
                        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                            req.abort();
                        } else {
                            req.continue();
                        }
                    });
                }
            ];
            crawler = new PuppeteerCrawler(crawlerOptions);
        }

        await crawler.run();
    }
}

module.exports = Workflow;

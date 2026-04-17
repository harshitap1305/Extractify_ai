/**
 * TwitterWorkflow.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates a Twitter scraping job from end to end:
 *   1. Creates a twitter_jobs record in SQLite
 *   2. Invokes TwitterScraper.scrape() with depth control
 *   3. Stores every collected tweet in twitter_results
 *   4. Emits real-time progress events (compatible with the SSE endpoint)
 *
 * Each tweet is stored as a row in twitter_results with its full JSON payload
 * so the frontend can retrieve, render, and export the data at any time.
 */

const TwitterScraper = require('./TwitterScraper');
const db = require('./Database');

class TwitterWorkflow {
    /**
     * Run a complete Twitter scraping job.
     *
     * @param {string}   jobId      - Unique job ID (UUID)
     * @param {string}   seedUrl    - Twitter URL to start from
     * @param {number}   maxDepth   - Crawl depth (passed from frontend)
     * @param {Function} onProgress - Callback({ status, message })
     */
    async runJob(jobId, seedUrl, maxDepth, onProgress, scraperConfig = {}) {
        const scraper = new TwitterScraper(scraperConfig);


        try {
            onProgress({ status: 'initializing', message: `Twitter Scraper initializing — seed: ${seedUrl}, depth: ${maxDepth}` });

            await scraper.init();   // launches browser, sets cookies, establishes session

            const tweets = await scraper.scrape(
                seedUrl,
                maxDepth,
                (msg) => onProgress({ status: 'fetching', message: msg })
            );

            onProgress({ status: 'saving', message: `Saving ${tweets.length} tweet(s) to database...` });

            const insertStmt = db.prepare(`
                INSERT INTO twitter_results
                    (job_id, tweet_url, source_url, depth, handle, display_name, posted_at, tweet_text, media_json, stats_json, quote_tweet)
                VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertMany = db.transaction((rows) => {
                for (const t of rows) {
                    insertStmt.run(
                        jobId,
                        t.tweetUrl   || null,
                        t.sourceUrl  || null,
                        t.depth      || 1,
                        t.handle     || null,
                        t.displayName || null,
                        t.postedAt   || null,
                        t.text       || null,
                        JSON.stringify(t.media   || []),
                        JSON.stringify(t.stats   || {}),
                        t.quoteTweet || null
                    );
                }
            });

            insertMany(tweets);

            db.prepare('UPDATE twitter_jobs SET status = ?, tweet_count = ? WHERE id = ?')
                .run('completed', tweets.length, jobId);

            onProgress({ status: 'completed', message: `Done! ${tweets.length} tweet(s) scraped and saved.` });

            return tweets;
        } catch (err) {
            db.prepare('UPDATE twitter_jobs SET status = ? WHERE id = ?')
                .run('failed', jobId);
            onProgress({ status: 'error', message: `Twitter scraper error: ${err.message}` });
            throw err;
        } finally {
            await scraper.close();
        }
    }
}

module.exports = TwitterWorkflow;

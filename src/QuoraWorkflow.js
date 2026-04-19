/**
 * QuoraWorkflow.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates a Quora scraping job from end to end:
 *   1. Creates a quora_jobs record in SQLite (passed from server params)
 *   2. Invokes QuoraScraper.scrape() with depth control
 *   3. Stores every collected answer in quora_results
 *   4. Emits real-time progress events
 *
 * Each answer is stored as a row in quora_results with its metadata
 * so the frontend can retrieve, render, and export the data at any time.
 */

const QuoraScraper = require('./QuoraScraper');
const db = require('./Database');

class QuoraWorkflow {
    /**
     * Run a complete Quora scraping job.
     *
     * @param {string}   jobId      - Unique job ID (UUID)
     * @param {string}   seedUrl    - Quora URL to start from
     * @param {number}   maxDepth   - Crawl depth (passed from frontend)
     * @param {Function} onProgress - Callback({ status, message })
     */
    async runJob(jobId, seedUrl, maxDepth, onProgress, scraperConfig = {}) {
        const scraper = new QuoraScraper(scraperConfig);

        try {
            onProgress({ status: 'initializing', message: `Quora Scraper initializing — seed: ${seedUrl}, depth: ${maxDepth}` });

            await scraper.init();

            const posts = await scraper.scrape(
                seedUrl,
                maxDepth,
                (msg) => onProgress({ status: 'fetching', message: msg })
            );

            onProgress({ status: 'saving', message: `Saving ${posts.length} post(s) to database...` });

            const insertStmt = db.prepare(`
                INSERT INTO quora_results
                    (job_id, url, source_url, depth, author, title, content, upvotes)
                VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertMany = db.transaction((rows) => {
                for (const p of rows) {
                    insertStmt.run(
                        jobId,
                        p.url        || null,
                        p.sourceUrl  || null,
                        p.depth      || 1,
                        p.author     || null,
                        p.title      || null,
                        p.content    || null,
                        p.upvotes    || null
                    );
                }
            });

            insertMany(posts);

            db.prepare('UPDATE quora_jobs SET status = ?, post_count = ? WHERE id = ?')
                .run('completed', posts.length, jobId);

            onProgress({ status: 'completed', message: `Done! ${posts.length} post(s) scraped and saved.` });

            return posts;
        } catch (err) {
            db.prepare('UPDATE quora_jobs SET status = ? WHERE id = ?')
                .run('failed', jobId);
            onProgress({ status: 'error', message: `Quora scraper error: ${err.message}` });
            throw err;
        } finally {
            await scraper.close();
        }
    }
}

module.exports = QuoraWorkflow;

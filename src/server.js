require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const SinglePromptExtractor = require('./SinglePromptExtractor');
const Workflow = require('./Workflow');
const TwitterWorkflow = require('./TwitterWorkflow');
const QuoraWorkflow = require('./QuoraWorkflow');
const db = require('./Database');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const extractor = new SinglePromptExtractor();
const engine = new Workflow(extractor);
const twitterEngine = new TwitterWorkflow();
const quoraEngine = new QuoraWorkflow();

// Global Job Store exclusively for LIVE terminal logs (in-memory)
// This clears out securely, while the actual jobs remain forever in SQLite.
const activeJobLogs = new Map();
const jobEmitter = new EventEmitter();

// Separate in-memory store for Twitter jobs
const activeTwitterLogs = new Map();
const twitterEmitter = new EventEmitter();

// Separate in-memory store for Quora jobs
const activeQuoraLogs = new Map();
const quoraEmitter = new EventEmitter();
const cancelledQuoraJobs = new Set();


// Background Job Dispatcher Route
app.post('/api/extract', async (req, res) => {
    const { url, prompt, depth, fastMode, aiFreeMode } = req.body;

    if (!url || (!prompt && !aiFreeMode)) {
        return res.status(400).json({ error: 'URL and prompt are required unless running in AI-Free Deterministic mode.' });
    }

    const maxDepth = depth ? parseInt(depth, 10) : 1;
    const jobId = uuidv4();

    // Database Initialization (Persistence)
    const stmt = db.prepare('INSERT INTO jobs (id, url, prompt, depth, status) VALUES (?, ?, ?, ?, ?)');
    stmt.run(jobId, url, prompt, maxDepth, 'running');

    activeJobLogs.set(jobId, { status: 'running', logs: [], result: null, error: null });

    setImmediate(async () => {
        try {
            await engine.runJob(url, prompt, maxDepth, fastMode, aiFreeMode, jobId, (progress) => {
                const payload = { type: 'progress', message: progress.message, status: progress.status };
                const jobState = activeJobLogs.get(jobId);
                if (jobState) jobState.logs.push(payload);
                jobEmitter.emit(`progress-${jobId}`, payload);
            });

            db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('completed', jobId);

            const resultsData = db.prepare('SELECT url, depth, raw_text, extracted_json as extracted, error FROM results WHERE job_id = ?').all(jobId);
            const formattedResults = resultsData.map(r => ({
                url: r.url,
                depth: r.depth,
                raw_text: r.raw_text,
                error: r.error,
                extracted: r.extracted ? JSON.parse(r.extracted) : {}
            }));

            const jobState = activeJobLogs.get(jobId);
            if (jobState) {
                jobState.status = 'completed';
                jobState.result = formattedResults;
            }
            jobEmitter.emit(`progress-${jobId}`, { type: 'result', data: formattedResults });

        } catch (error) {
            console.error('[Background Job Error]', error);
            db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('failed', jobId);

            const jobState = activeJobLogs.get(jobId);
            if (jobState) {
                jobState.status = 'failed';
                jobState.error = error.message;
            }
            jobEmitter.emit(`progress-${jobId}`, { type: 'error', error: error.message });
        }
    });

    res.status(202).json({ jobId, message: 'Job accepted for background execution' });
});

// The SSE Listen Route for Status Polling
app.get('/api/status', (req, res) => {
    const { jobId } = req.query;
    const jobState = activeJobLogs.get(jobId);

    if (!jobState) {
        // If it's not active, we gracefully tell the UI to stop polling.
        return res.status(404).json({ error: 'Job ID not actively streaming or found.' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    jobState.logs.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    if (jobState.status === 'completed') {
        res.write(`data: ${JSON.stringify({ type: 'result', data: jobState.result })}\n\n`);
        return res.end();
    }
    if (jobState.status === 'failed') {
        res.write(`data: ${JSON.stringify({ type: 'error', error: jobState.error })}\n\n`);
        return res.end();
    }

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (data.type === 'result' || data.type === 'error') {
            jobEmitter.removeListener(`progress-${jobId}`, onProgress);
            res.end();
        }
    };

    jobEmitter.on(`progress-${jobId}`, onProgress);

    req.on('close', () => {
        jobEmitter.removeListener(`progress-${jobId}`, onProgress);
    });
});

// NEW: Endpoint to fetch Job History from SQLite
app.get('/api/jobs', (req, res) => {
    try {
        const history = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
        res.json(history);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// NEW: Endpoint to export any prior job payload from SQLite
app.get('/api/jobs/:id/export', (req, res) => {
    try {
        const resultsData = db.prepare('SELECT url, depth, raw_text, extracted_json as extracted, error FROM results WHERE job_id = ?').all(req.params.id);
        const formatted = resultsData.map(r => ({
            url: r.url, depth: r.depth, raw_text: r.raw_text, error: r.error,
            extracted: r.extracted ? JSON.parse(r.extracted) : {}
        }));
        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Twitter Scraper Routes ────────────────────────────────────────────────────

// Set of jobIds that have been cancelled — checked by the workflow
const cancelledJobs = new Set();

/**
 * DELETE /api/twitter/jobs/:id/cancel
 * Signals the background scraping job to stop at its next safe checkpoint.
 */
app.delete('/api/twitter/jobs/:id/cancel', (req, res) => {
    const { id } = req.params;
    cancelledJobs.add(id);
    db.prepare("UPDATE twitter_jobs SET status = 'cancelled' WHERE id = ?").run(id);
    res.json({ ok: true, cancelled: id });
});

/**
 * POST /api/twitter/scrape
 * Body: { url: string, depth: number }
 *
 * Dispatches a background Twitter scraping job and immediately returns a jobId.
 * The client should connect to /api/twitter/status?jobId=<id> via SSE to track progress.
 */
app.post('/api/twitter/scrape', async (req, res) => {
    const { url, depth } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A Twitter URL is required.' });
    }

    // Validate that the URL looks like a Twitter/X URL
    const lowerUrl = url.toLowerCase();
    if (!lowerUrl.includes('twitter.com') && !lowerUrl.includes('x.com')) {
        return res.status(400).json({ error: 'URL must be a twitter.com or x.com address.' });
    }

    // Check that TWITTER_COOKIES is configured
    if (!process.env.TWITTER_COOKIES) {
        return res.status(500).json({
            error: 'TWITTER_COOKIES is not configured on the server. Add your exported cookies to the .env file.'
        });
    }

    const maxDepth        = depth ? Math.min(parseInt(depth, 10), 5) : 1;
    const maxDurationHours = req.body.maxDurationHours ? Math.min(parseFloat(req.body.maxDurationHours), 24) : 0;
    const maxTweetsPerUrl  = req.body.maxTweetsPerUrl  ? Math.min(parseInt(req.body.maxTweetsPerUrl, 10), 1000) : 200;
    const jobId            = uuidv4();

    // Persist the job in SQLite
    db.prepare('INSERT INTO twitter_jobs (id, seed_url, depth, status) VALUES (?, ?, ?, ?)')
        .run(jobId, url, maxDepth, 'running');


    // Initialise the in-memory log entry
    activeTwitterLogs.set(jobId, { status: 'running', logs: [], result: null, error: null });

    // Run scraping in background
    setImmediate(async () => {
        try {
            const scraperConfig = {
                maxDurationMs:  maxDurationHours ? Math.round(maxDurationHours * 3600 * 1000) : 0,
                maxTweetsPerUrl,
                scrollRounds:   10,
                cooldownMs:     3000,
                isCancelled:    () => cancelledJobs.has(jobId),   // checked at each URL
            };

            const tweets = await twitterEngine.runJob(jobId, url, maxDepth, (progress) => {
                const payload = { type: 'progress', message: progress.message, status: progress.status };
                const state   = activeTwitterLogs.get(jobId);
                if (state) state.logs.push(payload);
                twitterEmitter.emit(`progress-${jobId}`, payload);
            }, scraperConfig);


            const state = activeTwitterLogs.get(jobId);
            if (state) {
                state.status = 'completed';
                state.result = tweets;
            }
            twitterEmitter.emit(`progress-${jobId}`, { type: 'result', data: tweets });

        } catch (err) {
            console.error('[Twitter Job Error]', err);
            db.prepare('UPDATE twitter_jobs SET status = ? WHERE id = ?').run('failed', jobId);

            const state = activeTwitterLogs.get(jobId);
            if (state) {
                state.status = 'failed';
                state.error  = err.message;
            }
            twitterEmitter.emit(`progress-${jobId}`, { type: 'error', error: err.message });
        }
    });

    res.status(202).json({ jobId, message: 'Twitter scraping job accepted for background execution.' });
});

/**
 * GET /api/twitter/status?jobId=<id>
 * Server-Sent Events stream for real-time Twitter job progress.
 */
app.get('/api/twitter/status', (req, res) => {
    const { jobId } = req.query;
    const state = activeTwitterLogs.get(jobId);

    if (!state) {
        return res.status(404).json({ error: 'Twitter job ID not found or not actively streaming.' });
    }

    res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive'
    });

    // Replay buffered logs for late-connecting clients
    state.logs.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    if (state.status === 'completed') {
        res.write(`data: ${JSON.stringify({ type: 'result', data: state.result })}\n\n`);
        return res.end();
    }
    if (state.status === 'failed') {
        res.write(`data: ${JSON.stringify({ type: 'error', error: state.error })}\n\n`);
        return res.end();
    }

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (data.type === 'result' || data.type === 'error') {
            twitterEmitter.removeListener(`progress-${jobId}`, onProgress);
            res.end();
        }
    };

    twitterEmitter.on(`progress-${jobId}`, onProgress);

    req.on('close', () => {
        twitterEmitter.removeListener(`progress-${jobId}`, onProgress);
    });
});

/**
 * GET /api/twitter/jobs
 * Returns the history of all Twitter scraping jobs from SQLite.
 */
app.get('/api/twitter/jobs', (req, res) => {
    try {
        const jobs = db.prepare('SELECT * FROM twitter_jobs ORDER BY created_at DESC').all();
        res.json(jobs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/twitter/jobs/:id/results
 * Returns all scraped tweets for a specific job, parsed from SQLite.
 */
app.get('/api/twitter/jobs/:id/results', (req, res) => {
    try {
        const rows = db.prepare(
            'SELECT * FROM twitter_results WHERE job_id = ? ORDER BY depth ASC, scraped_at ASC'
        ).all(req.params.id);

        const formatted = rows.map(r => ({
            id:          r.id,
            tweetUrl:    r.tweet_url,
            sourceUrl:   r.source_url,
            depth:       r.depth,
            handle:      r.handle,
            displayName: r.display_name,
            postedAt:    r.posted_at,
            text:        r.tweet_text,
            media:       r.media_json   ? JSON.parse(r.media_json)  : [],
            stats:       r.stats_json   ? JSON.parse(r.stats_json)  : {},
            quoteTweet:  r.quote_tweet,
            scrapedAt:   r.scraped_at
        }));

        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Quora Scraper Routes ──────────────────────────────────────────────────────

app.delete('/api/quora/jobs/:id/cancel', (req, res) => {
    const { id } = req.params;
    cancelledQuoraJobs.add(id);
    db.prepare("UPDATE quora_jobs SET status = 'cancelled' WHERE id = ?").run(id);
    res.json({ ok: true, cancelled: id });
});

app.post('/api/quora/scrape', async (req, res) => {
    const { url, depth } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A Quora URL is required.' });
    }

    const lowerUrl = url.toLowerCase();
    if (!lowerUrl.includes('quora.com')) {
        return res.status(400).json({ error: 'URL must be a quora.com address.' });
    }

    if (!process.env.QUORA_COOKIES) {
        return res.status(500).json({
            error: 'QUORA_COOKIES is not configured on the server. Add your exported cookies to the .env file.'
        });
    }

    const maxDepth        = depth ? Math.min(parseInt(depth, 10), 5) : 1;
    const maxDurationHours = req.body.maxDurationHours ? Math.min(parseFloat(req.body.maxDurationHours), 24) : 0;
    const maxPostsPerUrl  = Number.MAX_SAFE_INTEGER;
    const jobId            = uuidv4();

    db.prepare('INSERT INTO quora_jobs (id, seed_url, depth, status) VALUES (?, ?, ?, ?)')
        .run(jobId, url, maxDepth, 'running');

    activeQuoraLogs.set(jobId, { status: 'running', logs: [], result: null, error: null });

    setImmediate(async () => {
        try {
            const scraperConfig = {
                maxDurationMs:  maxDurationHours ? Math.round(maxDurationHours * 3600 * 1000) : 0,
                maxPostsPerUrl,
                cooldownMs:     3000,
                isCancelled:    () => cancelledQuoraJobs.has(jobId),
            };

            const posts = await quoraEngine.runJob(jobId, url, maxDepth, (progress) => {
                const payload = { type: 'progress', message: progress.message, status: progress.status };
                const state   = activeQuoraLogs.get(jobId);
                if (state) state.logs.push(payload);
                quoraEmitter.emit(`progress-${jobId}`, payload);
            }, scraperConfig);

            const state = activeQuoraLogs.get(jobId);
            if (state) {
                state.status = 'completed';
                state.result = posts;
            }
            quoraEmitter.emit(`progress-${jobId}`, { type: 'result', data: posts });

        } catch (err) {
            console.error('[Quora Job Error]', err);
            db.prepare('UPDATE quora_jobs SET status = ? WHERE id = ?').run('failed', jobId);

            const state = activeQuoraLogs.get(jobId);
            if (state) {
                state.status = 'failed';
                state.error  = err.message;
            }
            quoraEmitter.emit(`progress-${jobId}`, { type: 'error', error: err.message });
        }
    });

    res.status(202).json({ jobId, message: 'Quora scraping job accepted for background execution.' });
});

app.get('/api/quora/status', (req, res) => {
    const { jobId } = req.query;
    const state = activeQuoraLogs.get(jobId);

    if (!state) {
        return res.status(404).json({ error: 'Quora job ID not found or not actively streaming.' });
    }

    res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive'
    });

    state.logs.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    if (state.status === 'completed') {
        res.write(`data: ${JSON.stringify({ type: 'result', data: state.result })}\n\n`);
        return res.end();
    }
    if (state.status === 'failed') {
        res.write(`data: ${JSON.stringify({ type: 'error', error: state.error })}\n\n`);
        return res.end();
    }

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (data.type === 'result' || data.type === 'error') {
            quoraEmitter.removeListener(`progress-${jobId}`, onProgress);
            res.end();
        }
    };

    quoraEmitter.on(`progress-${jobId}`, onProgress);

    req.on('close', () => {
        quoraEmitter.removeListener(`progress-${jobId}`, onProgress);
    });
});

app.get('/api/quora/jobs', (req, res) => {
    try {
        const jobs = db.prepare('SELECT * FROM quora_jobs ORDER BY created_at DESC').all();
        res.json(jobs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/quora/jobs/:id/results', (req, res) => {
    try {
        const rows = db.prepare(
            'SELECT * FROM quora_results WHERE job_id = ? ORDER BY depth ASC, scraped_at ASC'
        ).all(req.params.id);

        const formatted = rows.map(r => ({
            id:          r.id,
            url:         r.url,
            sourceUrl:   r.source_url,
            depth:       r.depth,
            author:      r.author,
            title:       r.title,
            content:     r.content,
            upvotes:     r.upvotes,
            scrapedAt:   r.scraped_at
        }));

        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(port, () => {
    console.log(`Extractify AI Engine with SQLite Persistence running at http://localhost:${port}`);
});


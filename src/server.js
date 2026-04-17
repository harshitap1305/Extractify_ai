require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const SinglePromptExtractor = require('./SinglePromptExtractor');
const Workflow = require('./Workflow');
const db = require('./Database');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const extractor = new SinglePromptExtractor();
const engine = new Workflow(extractor);

// Global Job Store exclusively for LIVE terminal logs (in-memory)
// This clears out securely, while the actual jobs remain forever in SQLite.
const activeJobLogs = new Map();
const jobEmitter = new EventEmitter();

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

app.listen(port, () => {
    console.log(`Extractify AI Engine with SQLite Persistence running at http://localhost:${port}`);
});

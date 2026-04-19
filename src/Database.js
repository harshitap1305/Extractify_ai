const Database = require('better-sqlite3');
const path = require('path');

// Store the SQLite file safely in the root project directory natively
const dbPath = path.join(__dirname, '../extractify.db');
const db = new Database(dbPath, { verbose: null });

// Enforce highly concurrent read-write scaling operations for SQLite natively
db.pragma('journal_mode = WAL');

// Initialize database architectural schemas
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT,
    prompt TEXT,
    depth INTEGER,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    url TEXT,
    depth INTEGER,
    raw_text TEXT,
    extracted_json TEXT,
    error TEXT,
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );

  -- ── Twitter scraper tables ─────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS twitter_jobs (
    id          TEXT PRIMARY KEY,
    seed_url    TEXT NOT NULL,
    depth       INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL DEFAULT 'running',
    tweet_count INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS twitter_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL,
    tweet_url    TEXT,
    source_url   TEXT,
    depth        INTEGER,
    handle       TEXT,
    display_name TEXT,
    posted_at    TEXT,
    tweet_text   TEXT,
    media_json   TEXT,   -- JSON array of media URLs
    stats_json   TEXT,   -- JSON object { likes, retweets, replies, … }
    quote_tweet  TEXT,
    scraped_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES twitter_jobs(id)
  );
  -- ── Quora scraper tables ───────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS quora_jobs (
    id          TEXT PRIMARY KEY,
    seed_url    TEXT NOT NULL,
    depth       INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL DEFAULT 'running',
    post_count  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS quora_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL,
    url          TEXT,
    source_url   TEXT,
    depth        INTEGER,
    author       TEXT,
    title        TEXT,
    content      TEXT,
    upvotes      TEXT,
    scraped_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES quora_jobs(id)
  );
`);

module.exports = db;

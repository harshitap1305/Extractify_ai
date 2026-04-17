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
`);

module.exports = db;

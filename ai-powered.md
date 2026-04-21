# Extractify AI - AI Powered Crawling Execution Flow

This document details the end-to-end execution pipeline of the core AI Powered Scraper, tracing the flow from the moment a user submits a prompt on the dashboard to the final AI-structured response generation.

---

## 1. Frontend: Job Initiation
**Location:** `public/script.js` -> `#extract-form` submit event listener

- The user specifies an target **URL**, a custom **Prompt**, a preferred **Depth**, and toggles **Fast Mode** (Static HTML vs Headless Browser).
- When "Scrape" is clicked, the UI enters a loading state ("Processing" badge) and clears any previous logs.
- An HTTP `POST` request is fired to the backend endpoint `/api/extract` with the JSON payload: `{ url, prompt, depth, fastMode, aiFreeMode: false }`.

## 2. Backend: API Validation & Job Dispatch
**Location:** `src/server.js` -> `POST /api/extract` route

- The server validates that both a URL and a prompt are present.
- A unique `jobId` (UUID) is generated.
- The job is instantly persisted to the SQLite database (`jobs` table) with the status `'running'`, alongside the metadata setup.
- To avoid bottlenecking the HTTP thread, the system instantly returns `HTTP 202 Accepted` alongside the `jobId`.
- The actual crawling workload is offloaded to the background via Node.js `setImmediate()`, triggering `engine.runJob()`.

## 3. Frontend: Live Terminal Streaming (SSE)
**Location:** `public/script.js` & `src/server.js`

- Having received the `jobId`, the frontend script opens a Server-Sent Events (SSE) connection: `EventSource('/api/status?jobId=...')`.
- The backend matches this ID to an active log buffer mapping in memory (`activeJobLogs`) and pipes log updates to the client dynamically.
- System progress events—like `fetching`, `cleaning`, `extracting`—are streamed iteratively to simulate a live console terminal.

## 4. Crawlee Orchestration: Engine Scaling & Fetching
**Location:** `src/Workflow.js`

The `Workflow` class leverages the massively parallel `Crawlee` library to govern the job.

### 4.1. Queue Setup
- A native `RequestQueue` is booted, ensuring duplicate URLs are never visited twice within the same job natively via Crawlee memory.
- The initial `seedUrl` is injected into the queue under `depth: 1`.

### 4.2 Engine Routing
Depending on if the user toggled `fastMode`:
- **Fast Mode (`CheerioCrawler`)**: Executes lightweight HTTP requests utilizing highly configured user-agent spoofing to grab the static DOM instantaneously. 
- **Deep Mode (`PuppeteerCrawler`)**: Spins up dynamic Headless Chrome contexts. Intercepts and blocks visual assets (images, css, media) natively to save memory, while executing dynamic `window.scrollBy` routines to aggressively trigger Javascript lazy-loaded paragraphs/infinite-scroll texts before scraping the DOM content.

## 5. Pruning and Normalization
**Location:** `src/Cleaner.js` & `src/Workflow.js` 

- The scraped raw HTML is funnelled into a scrubbing module (`Cleaner.js`).
- Scripts, Styles, iFrames, and unnecessary structural wrappers are stripped out using the Mozilla `Readability` library or raw regex fallback.
- The remaining payload is mapped to a raw document string (`raw_text`), which is then explicitly sliced to a max cap of `250,000` characters to prevent catastrophic AI context window overflow.

## 6. LLM Extraction and Rate Limiting
**Location:** `src/SinglePromptExtractor.js` & `src/Workflow.js`

- The `safeText` and the user's `prompt` are fed into the `SinglePromptExtractor`.
- **Throttling Mechanisms**: To respect API free-tier restraints (`~30 RPM`), the extraction request hits a `Bottleneck` layer (`minTime: 3000`). If a `HTTP 429 Rate Limit` is thrown anyway, Bottleneck recognizes the code and initiates an automatic exponential local backoff (5-second freeze on that specific job before retry).
- The text is passed into the Groq API utilizing the `llama-3.3-70b-versatile` model. 
- It forces deterministic configuration (`temperature: 0.1`) and mandates a response explicitly wrapped mechanically via `response_format: { type: 'json_object' }`.
- System instructions guarantee output strictly adheres to pure JSON blocks, removing markdown formatting or conversational filler text. 

## 7. Deep Crawling (Sub-Link Discovery)
**Location:** `src/Workflow.js`

- If `depth` is strictly less than the `maxDepth` limit requested, the `Workflow` loop proceeds to recursive queueing.
- Utilizing Crawlee's `enqueueLinks()`, the algorithm filters specifically for `same-domain` URLs nested inside the active DOM (ignoring specific redundant footer classes).
- Enqueued links are pushed asynchronously to depth `depth + 1` and evaluated concurrently in parallel limits by Crawlee cluster concurrency algorithms.

## 8. Persistence & Final Results Signal
**Location:** `src/server.js`

- Every individual parsed JSON output per URL is saved iteratively during execution directly into the SQLite `results` table (`extracted_json` alongside `raw_text` metrics).
- Once the Crawlee queue fully drains or the crawler returns empty arrays, execution returns entirely to `server.js`.
- An aggregated select statement queries all successfully structured `results` rows correlating to the `jobId` and groups them natively.
- The `jobs` status updates to `completed`.
- A final `result` event containing the combined array structure is transmitted across the SSE Pipeline, allowing the client to formally display "Success", render the final formatted JSON block on the UI, and unlock the CSV JSON download export modules.

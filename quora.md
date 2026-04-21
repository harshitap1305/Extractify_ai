# Extractify AI - Quora Scraper Execution Flow

This document details the exact process of the Quora scraping pipeline, tracking the execution flow from the moment the user interacts with the dashboard until the final output is delivered.

---

## 1. Frontend: Job Initiation
**Location:** `public/script.js` -> `#extract-quora-form` sumbit event listener

- The user configures the scrape parameters entering a Quora specific URL, desired depth, and max duration limit, then clicks "Scrape".
- The frontend disables the "Scrape" button, attaches a "Processing" badge, clears any previous terminal outputs, and reveals a "Stop" button to allow job cancellation.
- An HTTP `POST` request is sent to the backend at `/api/quora/scrape` carrying the payload: `{ url, depth, maxDurationHours }`.

## 2. Backend: Request Validation & Dispatch
**Location:** `src/server.js` -> `POST /api/quora/scrape` route

- Upon receiving the request, the backend immediately validates that the provided URL belongs to the `quora.com` domain.
- It verifies that the `QUORA_COOKIES` environment variable is present, ensuring that scraping can run smoothly within an authenticated context.
- A unique Job ID (`UUID`) is generated for tracking.
- The new job is synchronously persisted to the local SQLite database (`quora_jobs` table) with the status `'running'`.
- An in-memory mapping (`activeQuoraLogs`) is populated for this `jobId` so that logs can be stored and sent to the client dynamically.
- The backend immediately responds to the frontend with `HTTP 202 Accepted` along with the `jobId` to avoid blocking the main thread, while simultaneously dispatching the background scraping job via Node`s `setImmediate()` invoking `quoraEngine.runJob()`.

## 3. Frontend: Live Terminal Streaming (SSE)
**Location:** `public/script.js` & `src/server.js`

- After receiving the `jobId` and HTTP 202 payload, the Javascript on the frontend establishes a new connection via Server-Sent Events (SSE) `EventSource('/api/quora/status?jobId=...')`.
- The backend matches the provided ID and pipes the memory log stream directly back to the active client chunk-by-chunk.
- As the scraper proceeds, it pushes `progress` event objects across the line, updating the frontend terminal mimicking a real-time console. The script simultaneously checks logs to extract numbers and maintain a live extracted post count.

## 4. Backend: Workflow Orchestration
**Location:** `src/QuoraWorkflow.js`

- The `QuoraWorkflow` acts as the intermediary executing the heavy task inside an error-caught scope.
- It instantiates `QuoraScraper` and registers the necessary stop/cancellation callbacks (`isCancelled: () => cancelledQuoraJobs.has(jobId)`).
- Through the injected `onProgress` function parameter, it continuously pushes progress reports upward towards the SSE pipeline of `server.js`.
- It awaits the final resolved scraper results layout (`scraper.init()` and `scraper.scrape()`).

## 5. Scraper Core: Data Fetching and Navigation
**Location:** `src/QuoraScraper.js`

The `QuoraScraper` performs the actual crawling, implementing deep anti-blocking and stealth mechanics:

### 5.1. Session Setup
- A resilient browser instance executes via Puppeteer utilizing stealth flags like `--disable-blink-features=AutomationControlled` to help avoid automated bot detection.
- Cookies read from the `QUORA_COOKIES` environment variables are injected into the context session, guaranteeing verified account states.
- The browser opens `quora.com`, loading the initialized user authenticated session state prior to executing searches.

### 5.2. Post Traversal
- The Scraper visits the requested Quora page.
- Using injected scripts into the context of the page:
  - It searches for and triggers the action for `" (More)"` expanded content buttons ensuring answers aren't truncated by Quora.
  - It queries the DOM utilizing CSS selectors targeted at Quora's inner answer classes (`.spacing_log_answer_content`, `.q-box.qu-wordBreak...`) capturing Author, Text body, Title nodes, and dynamically reading the upvote digits.
- To discover items lower down the thread, the script executes programmatic window scrolls mimicking user interaction `window.scrollBy(0, step)`, followed by random delays (`Math.random()`) and dedicated `sleep` intervals (cooldowns) to avoid generating excessive traffic warnings.

### 5.3. Deep Crawling
- If the requested Depth is greater than 1, the browser simultaneously analyzes related question links listed internally (`href*="/"` pointing strictly to other pages on `quora.com`).
- A limited subset of these related links is added to a local queue.
- The scraper runs recursively over the new URLs down to the `maxDepth` requested or until conditions hit the `maxDurationHours` timeout. 

## 6. Backend: Storage and Persistence
**Location:** `src/QuoraWorkflow.js`

- Once crawling concludes recursively or meets limit checkpoints, `QuoraScraper` collapses and yields a fully formatted array of extracted data objects.
- `QuoraWorkflow` initiates an atomic SQLite transaction loop `insertMany`, securely storing each data row directly inside the local persistent table (`quora_results`), linking columns via `job_id`.
- The matching index in `quora_jobs` updates its values to `completed` and attaches the cumulative count value of scraped posts.

## 7. Frontend: Completion and Export Data Delivery
**Location:** `public/script.js`

- Back inside `server.js`, a final signal payload shaped as `{ type: 'result', data: posts }` is broadcasted over the EventSource channel to the specific connected client containing all fetched JSON objects.
- The client receives this finish line output, displays the data successfully within its code block, disables the connection stream, switches the status badge to "Complete", and removes "Scraping" indicators.
- Export options (JSON and CSV) dynamically mount and bind via HTML DOM element `display: flex`, allowing the local user directly downloading their persistent parsed database information entirely.

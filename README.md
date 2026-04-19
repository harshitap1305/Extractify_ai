# Extractify AI

Extractify AI is a powerful, multi-modal web data extraction engine. It features four distinct scraping architectures built into a single, cohesive dashboard:

1. **AI Web Scraper Engine:** Deep LLM-powered crawling leveraging Gemini to extract structured JSON data from any arbitrary website.
2. **AI-Free News Scraper:** High-performance, deterministic article extraction using Mozilla Readability (extracts title, date, and body) without using API credits.
3. **High-Volume Twitter Crawler:** An advanced, production-grade headless browser scraper configured for deep background scraping and robust JSON interception.
4. **Native Quora Crawler:** An authenticated headless orchestrator using dynamic DOM traversal and scroll triggers to scrape rich questions, answers, upvotes, and multi-thread contexts from Quora without triggering login paywalls.

## 🚀 Features

### 1. General & AI Scraping
* **LLM Intelligence:** Point the scraper at any site and let Gemini figure out the DOM structure to extract specific schemas.
* **Cost-Efficient Deterministic Mode:** Fall-back to classic DOM parsing (Mozilla Readability) for news websites to save on API usage.

### 2. Twitter Scraping Engine
* **Hybrid Native Interception:** Avoids fragile DOM scraping by natively scrolling the timeline and intercepting Twitter's internal GraphQL JSON API responses. Ensures 100% data fidelity (exact timestamps, hidden media, precise metrics).
* **Deep Fan-Out Crawling:** Set the `Depth` > 1 to automatically trace conversations. The engine will scrape a page, recursively extract comment/author profiles directly from the JSON, and then queue those newly discovered profiles for scraping.
* **Production Runtime Controls:**
  * Define explicit limits via **Max Posts**.
  * Set a time limit for asynchronous crawls via **Duration**.
  * View Real-time Server-Sent Events (SSE) streaming progress in the UI.
  * Stop active crawls on the fly without losing previously captured data.
* **Anti-Bot Defenses:** Randomizes mouse wheel events, applies variable timeouts, implements aggressive cooldowns, and auto-refreshes session `x-csrf-token` headers on the fly. 

### 3. Quora Scraping Engine
* **Authenticated Crawling:** Supply your native Quora cookies horizontally to bypass "Registered users only" view walls seamlessly.
* **Resilient DOM Traversal:** Detects dynamically named Quora CSS boxes and accurately breaks down questions into structured text with author profiles and upvote metrics attached. 
* **Deep Fan-Out Crawling:** Set depth to traverse related community discussions. The engine navigates across `quora.com` automatically capturing hidden branches.
* **Production Runtime Controls:**
  * Auto-restarts browser context periodically during long-running 12+ hour jobs to avoid internal bloat.
  * Adjust limits effortlessly via UI configurations.

### 4. Full-Stack Data Management
* **SQLite Persistence:** Every single extracted article, tweet, quora answer, and crawler job is saved into an indexed local SQLite database automatically.
* **Dashboard Interface:** A sleek, multi-tab frontend interface connected to a live SSE backend so you can watch background jobs stream results directly to your browser.

---

## ⚙️ Setup & Installation

**1. Clone & Install Dependencies**
```bash
git clone <repository-url>
cd Extractify_ai
npm install
```

**2. Configure Environment Variables**
Copy the template file to create your active environment configuration:
```bash
cp .env.template .env
```
Inside your `.env` file, configure the following:
* `GEMINI_API_KEY`: Your Google Deepmind Gemini API key (required for the AI web scraper).
* `TWITTER_COOKIES`: A JSON array string of your exported cookies from an active Twitter session. This is required for the Twitter scraper to function (since Twitter forbids anonymous browsing). *Ensure it contains the `ct0` and `auth_token` cookies.*
* `QUORA_COOKIES`: A JSON array string of your exported cookies from an active Quora session. Required to prevent full-screen login popups during deep recursive scrolling.

**3. Run the Application**
```bash
node src/server.js
```
The backend server and the frontend dashboard will be available at: **`http://localhost:3000`**

---

## 📖 Usage Guide

Open `http://localhost:3000` in your browser. The dashboard is divided into specific tool tabs:

* **AI Crawler Tab:** Enter a seed URL, define the JSON schema you want it to detect, and start the job.
* **News Parser Tab:** Enter standard news article links. The backend will rapidly download and parse the clean text and publication dates.
* **Twitter Scraper Tab:**
  * **Seed URL:** Provide a Twitter search query URL (e.g. `https://x.com/search?q=AI`) or a specific profile (`https://x.com/elonmusk`). Note that scraping the default home feed (`https://x.com/`) is naturally limited by Twitter's algorithm to ~80-150 tweets.
  * **Depth:** Set to `1` to only scrape the immediate page. Set to `2` to extract profiles from the initial page and then recursively scrape all those profiles.
  * **Time Limit:** Set your absolute ceilings to ensure the crawler doesn't eat up the entire server memory during deep recursive scraping.
* **Quora Crawler Tab:**
  * **Seed URL:** Supply a Quora URL (`https://www.quora.com/topic/Science`).
  * **Depth:** Navigate naturally across sub-questions indefinitely linking nodes.
  * **Time Limits:** Restrict execution cleanly logic using native options (e.g. `0.25h`, `24h`, etc). Note that there is no native 'max post' limit, allowing pure DOM extraction capability until exhaustion.

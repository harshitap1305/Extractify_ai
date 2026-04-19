let finalExtractedData = null;

// --- Dashboard Navigation Logic ---
const navNewCrawl  = document.getElementById('nav-new-crawl');
const navNewsCrawl = document.getElementById('nav-news-crawl');
const navTwitter   = document.getElementById('nav-twitter');
const navQuora     = document.getElementById('nav-quora');
const navHistory   = document.getElementById('nav-history');

const viewCrawl    = document.getElementById('view-crawl');
const viewNews     = document.getElementById('view-news');
const viewTwitter  = document.getElementById('view-twitter');
const viewQuora    = document.getElementById('view-quora');
const viewHistory  = document.getElementById('view-history');
const historyContainer = document.getElementById('history-container');

function switchView(viewName) {
    [navNewCrawl, navNewsCrawl, navTwitter, navQuora, navHistory].forEach(el => el.classList.remove('active'));
    viewCrawl.style.display   = 'none';
    viewNews.style.display    = 'none';
    viewTwitter.style.display = 'none';
    viewQuora.style.display   = 'none';
    viewHistory.style.display = 'none';

    if (viewName === 'crawl') {
        navNewCrawl.classList.add('active');
        viewCrawl.style.display = 'grid';
    } else if (viewName === 'news') {
        navNewsCrawl.classList.add('active');
        viewNews.style.display = 'grid';
    } else if (viewName === 'twitter') {
        navTwitter.classList.add('active');
        viewTwitter.style.display = 'grid';
    } else if (viewName === 'quora') {
        navQuora.classList.add('active');
        viewQuora.style.display = 'grid';
    } else if (viewName === 'history') {
        navHistory.classList.add('active');
        viewHistory.style.display = 'grid';
        loadJobHistory();
    }
}

navNewCrawl.addEventListener('click',  () => switchView('crawl'));
navNewsCrawl.addEventListener('click', () => switchView('news'));
navTwitter.addEventListener('click',   () => switchView('twitter'));
navQuora.addEventListener('click',     () => switchView('quora'));
navHistory.addEventListener('click',   () => switchView('history'));

// Duplicate extraction form bindings specifically for 'extract-news-form'
document.getElementById('extract-news-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Logic for news extraction — handled by the second listener below
});

// ── Twitter Depth Slider Live Label ──────────────────────────────────────────
const twitterDepthSlider = document.getElementById('twitter-depth');
const twitterDepthLabel  = document.getElementById('twitter-depth-label');
twitterDepthSlider.addEventListener('input', () => {
    twitterDepthLabel.textContent = twitterDepthSlider.value;
    twitterDepthLabel.style.transform = 'scale(1.2)';
    setTimeout(() => { twitterDepthLabel.style.transform = 'scale(1)'; }, 150);
});

// ── Twitter Max Posts Slider Live Label ───────────────────────────────────────
const twitterMaxPostsSlider = document.getElementById('twitter-max-posts');
const twitterMaxPostsLabel  = document.getElementById('twitter-max-posts-label');
twitterMaxPostsSlider.addEventListener('input', () => {
    twitterMaxPostsLabel.textContent = twitterMaxPostsSlider.value;
    twitterMaxPostsLabel.style.transform = 'scale(1.2)';
    setTimeout(() => { twitterMaxPostsLabel.style.transform = 'scale(1)'; }, 150);
});

window.toggleEngineMode = function () {
    const isDeterministic = document.querySelector('input[name="engineMode"]:checked').value === 'deterministic';
    const promptGroup = document.getElementById('prompt-group');
    const promptInput = document.getElementById('prompt');

    if (isDeterministic) {
        promptGroup.style.opacity = '0.5';
        promptInput.disabled = true;
        promptInput.required = false;
        promptInput.placeholder = "AI disabled. Using Mozilla Readability deterministic extraction (Title / Date / Body).";
    } else {
        promptGroup.style.opacity = '1';
        promptInput.disabled = false;
        promptInput.required = true;
        promptInput.placeholder = "Extract the top 5 articles with titles and links...";
    }
};

async function loadJobHistory() {
    historyContainer.innerHTML = '<span style="color: var(--primary);">Fetching SQLite archive...</span>';
    try {
        const [coreRes, twitterRes, quoraRes] = await Promise.all([
            fetch('/api/jobs').catch(() => ({ ok: false })),
            fetch('/api/twitter/jobs').catch(() => ({ ok: false })),
            fetch('/api/quora/jobs').catch(() => ({ ok: false }))
        ]);

        const coreJobs    = coreRes.ok ? await coreRes.json() : [];
        const twitterJobs = twitterRes.ok ? await twitterRes.json() : [];
        const quoraJobs   = quoraRes.ok ? await quoraRes.json() : [];

        const allJobs = [];

        if (Array.isArray(coreJobs)) {
            coreJobs.forEach(j => allJobs.push({
                ...j, type: 'core', title: j.url, detail: `Goal: ${j.prompt}`
            }));
        }
        if (Array.isArray(twitterJobs)) {
            twitterJobs.forEach(j => allJobs.push({
                ...j, type: 'twitter', title: j.seed_url || 'Twitter Query', detail: `Depth: ${j.depth}`
            }));
        }
        if (Array.isArray(quoraJobs)) {
            quoraJobs.forEach(j => allJobs.push({
                ...j, type: 'quora', title: j.seed_url || 'Quora URL', detail: `Depth: ${j.depth}`
            }));
        }

        allJobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (allJobs.length === 0) {
            historyContainer.innerHTML = '<span style="color: var(--primary); opacity: 0.8;">No completed jobs found. Initialize your first extraction!</span>';
            return;
        }

        historyContainer.innerHTML = allJobs.map(job => `
            <div style="background: rgba(255,255,255,0.6); border: 1px solid var(--glass-border); padding: 1.5rem; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05); margin-bottom: 1rem;">
                <div style="display: flex; flex-direction: column; gap: 0.5rem; max-width: 60%;">
                    <h4 style="color: var(--text-dark); font-family: 'Inter', sans-serif;">
                        ${job.type === 'twitter' ? '🐦 ' : job.type === 'quora' ? '🔴 ' : '🤖 '}
                        ${job.title}
                    </h4>
                    <pre style="padding: 0; background: transparent; color: var(--primary); font-size: 0.85rem; max-height: unset; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${job.detail}</pre>
                    <span style="font-size: 0.8rem; color: #888;">Status: <b>${job.status.toUpperCase()}</b> • Scraped ${new Date(job.created_at).toLocaleString()}</span>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button onclick="downloadHistoryJSON('${job.id}', '${job.type}')" class="btn secondary" style="padding: 0.6rem 1rem; font-size: 0.85rem;">Download JSON</button>
                    <button onclick="downloadHistoryCSV('${job.id}', '${job.type}')" class="btn outline" style="padding: 0.6rem 1rem; font-size: 0.85rem; border: 2px solid var(--primary-light) !important;">Download CSV</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        historyContainer.innerHTML = `<span style="color: red;">Error fetching databases: ${e.message}</span>`;
    }
}

// --- Crawl API Execution Logic ---
document.getElementById('extract-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const urlInput = document.getElementById('url').value;
    const promptInput = document.getElementById('prompt').value;
    const depthInput = document.getElementById('depth').value;
    const fastModeInput = document.getElementById('fastMode').checked;
    const aiFreeMode = false;

    const submitBtn = document.getElementById('submit-btn');
    const statusBadge = document.getElementById('status-badge');
    const jsonOutput = document.getElementById('json-output');
    const exportSection = document.getElementById('export-section');

    // Reset data for new job
    finalExtractedData = null;

    // UI Setup for loading
    submitBtn.disabled = true;
    submitBtn.classList.add('btn-loading');
    statusBadge.className = 'badge processing';
    statusBadge.textContent = 'Processing';
    jsonOutput.style.color = '#FFF';
    jsonOutput.textContent = 'Allocating Crawler resources via SQLite Pipeline...\n';

    if (exportSection) exportSection.style.display = 'none';

    try {
        const response = await fetch('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: urlInput, prompt: promptInput, depth: depthInput, fastMode: fastModeInput, aiFreeMode })
        });

        const config = await response.json();

        if (!response.ok) {
            throw new Error(config.error || 'Server rejected extraction request');
        }

        const jobId = config.jobId;
        jsonOutput.textContent += `[SYSTEM] Job UUID ${jobId} allocated. Connecting to cluster stream...\n------------------------------\n`;

        // Connect to Server-Sent-Events (SSE) stream natively
        let eventSource = null;

        try {
            eventSource = new EventSource(`/api/status?jobId=${jobId}`);

            eventSource.onmessage = function (event) {
                const data = JSON.parse(event.data);

                if (data.type === 'progress') {
                    jsonOutput.textContent += `[${data.status.toUpperCase()}] ${data.message}\n`;
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;
                }
                else if (data.type === 'result') {
                    finalExtractedData = data.data; // Keep natively available for export
                    statusBadge.className = 'badge success';
                    statusBadge.textContent = 'Success';
                    jsonOutput.style.color = '#DCCCAC';
                    jsonOutput.textContent += `\n=== FINAL CLUSTER DATA ===\n${JSON.stringify(data.data, null, 2)}`;
                    eventSource.close();

                    submitBtn.disabled = false;
                    submitBtn.classList.remove('btn-loading');
                    if (exportSection) exportSection.style.display = 'flex'; // Un-hide Export buttons
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;
                }
                else if (data.type === 'error') {
                    throw new Error(data.error);
                }
            };

            eventSource.onerror = function () {
                // If stream breaks unexpectedly
                if (eventSource.readyState === EventSource.CLOSED) return;
                throw new Error("SSE Stream forcefully disconnected by terminal.");
            };

        } catch (error) {
            if (eventSource) eventSource.close();
            statusBadge.className = 'badge error';
            statusBadge.textContent = 'Failed';
            jsonOutput.style.color = '#E46464';
            jsonOutput.textContent += `\n[FATAL ERROR] ${error.message}`;

            submitBtn.disabled = false;
            submitBtn.classList.remove('btn-loading');
            if (exportSection) exportSection.style.display = 'none';
        }
    } catch (error) {
        statusBadge.className = 'badge error';
        statusBadge.textContent = 'Network Error';
        jsonOutput.style.color = '#E46464';
        jsonOutput.textContent += `\n[NETWORK ERROR] ${error.message}`;

        submitBtn.disabled = false;
        submitBtn.classList.remove('btn-loading');
        if (exportSection) exportSection.style.display = 'none';
    }
});

let finalNewsExtractedData = null;

// --- News Crawler Specific Event ---
document.getElementById('extract-news-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const urlInput = document.getElementById('news-url').value;
    const depthInput = document.getElementById('news-depth').value;
    const fastModeInput = document.getElementById('news-fastMode').checked;
    const submitBtn = document.getElementById('news-submit-btn');
    const statusBadge = document.getElementById('news-status-badge');
    const jsonOutput = document.getElementById('news-json-output');
    const exportSection = document.getElementById('news-export-section');

    finalNewsExtractedData = null;
    submitBtn.disabled = true;
    submitBtn.classList.add('btn-loading');
    statusBadge.className = 'badge processing';
    statusBadge.textContent = 'Processing';
    jsonOutput.style.color = '#FFF';
    jsonOutput.textContent = 'Initializing Semantic Scraper bypassing AI Nodes...\n';
    if (exportSection) exportSection.style.display = 'none';

    try {
        const response = await fetch('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: urlInput, prompt: "News Extraction bypass", depth: depthInput, fastMode: fastModeInput, aiFreeMode: true })
        });

        const config = await response.json();
        if (!response.ok) throw new Error(config.error || 'Server rejected extraction request');

        const jobId = config.jobId;
        jsonOutput.textContent += `[SYSTEM] Scraper Job ${jobId} allocated. Listening to cluster...\n------------------------------\n`;

        let eventSource = null;
        try {
            eventSource = new EventSource(`/api/status?jobId=${jobId}`);
            eventSource.onmessage = function (event) {
                const data = JSON.parse(event.data);
                if (data.type === 'progress') {
                    jsonOutput.textContent += `[${data.status.toUpperCase()}] ${data.message}\n`;
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;
                } else if (data.type === 'result') {
                    finalNewsExtractedData = data.data;
                    statusBadge.className = 'badge success';
                    statusBadge.textContent = 'Success';
                    jsonOutput.style.color = '#DCCCAC';
                    jsonOutput.textContent += `\n=== NEWS SCRAPED DATA ===\n${JSON.stringify(data.data, null, 2)}`;
                    eventSource.close();
                    submitBtn.disabled = false;
                    submitBtn.classList.remove('btn-loading');
                    if (exportSection) exportSection.style.display = 'flex';
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;
                } else if (data.type === 'error') {
                    throw new Error(data.error);
                }
            };
            eventSource.onerror = function () {
                if (eventSource.readyState === EventSource.CLOSED) return;
                throw new Error("Terminal connection severed.");
            };
        } catch (error) {
            if (eventSource) eventSource.close();
            statusBadge.className = 'badge error';
            statusBadge.textContent = 'Failed';
            jsonOutput.style.color = '#E46464';
            jsonOutput.textContent += `\n[FATAL ERROR] ${error.message}`;
            submitBtn.disabled = false;
            submitBtn.classList.remove('btn-loading');
        }
    } catch (error) {
        statusBadge.className = 'badge error';
        statusBadge.textContent = 'Network Error';
        jsonOutput.style.color = '#E46464';
        jsonOutput.textContent += `\n[NETWORK ERROR] ${error.message}`;
        submitBtn.disabled = false;
        submitBtn.classList.remove('btn-loading');
    }
});

// --- Download Global Functions ---

function initiateDownload(dataArray, type = 'json') {
    if (!dataArray || dataArray.length === 0) {
        alert("No database results detected for archive.");
        return;
    }

    if (type === 'json') {
        const blob = new Blob([JSON.stringify(dataArray, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `extractify_data_${Date.now()}.json`;
        link.click();
    } else {
        const flatData = dataArray.map(item => {
            let cleanExtracted = {};
            if (item.extracted && typeof item.extracted === 'object') {
                cleanExtracted = item.extracted;
            }
            return {
                source_url: item.url,
                crawl_depth: item.depth,
                ...cleanExtracted,
                raw_text: item.raw_text
            };
        });

        const csvString = Papa.unparse(flatData);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `extractify_data_${Date.now()}.csv`;
        link.click();
    }
}

// Download Handlers (Live Pane)
document.getElementById('btn-export-json').addEventListener('click', () => initiateDownload(finalExtractedData, 'json'));
document.getElementById('btn-export-csv').addEventListener('click',  () => initiateDownload(finalExtractedData, 'csv'));

// Download Handlers (News Scraper Pane)
document.getElementById('btn-export-news-json').addEventListener('click', () => initiateDownload(finalNewsExtractedData, 'json'));
document.getElementById('btn-export-news-csv').addEventListener('click',  () => initiateDownload(finalNewsExtractedData, 'csv'));

// Download Handlers (History Async Pane)
window.downloadHistoryJSON = async (jobId, type = 'core') => {
    let endpoint = `/api/jobs/${jobId}/export`;
    if (type === 'twitter') endpoint = `/api/twitter/jobs/${jobId}/results`;
    if (type === 'quora') endpoint = `/api/quora/jobs/${jobId}/results`;

    const res = await fetch(endpoint);
    const data = await res.json();

    if (type === 'twitter') return initiateTwitterDownload(data, 'json');
    if (type === 'quora') return initiateQuoraDownload(data, 'json');
    initiateDownload(data, 'json');
};
window.downloadHistoryCSV = async (jobId, type = 'core') => {
    let endpoint = `/api/jobs/${jobId}/export`;
    if (type === 'twitter') endpoint = `/api/twitter/jobs/${jobId}/results`;
    if (type === 'quora') endpoint = `/api/quora/jobs/${jobId}/results`;

    const res = await fetch(endpoint);
    const data = await res.json();

    if (type === 'twitter') return initiateTwitterDownload(data, 'csv');
    if (type === 'quora') return initiateQuoraDownload(data, 'csv');
    initiateDownload(data, 'csv');
};

// ── Twitter / X Scraper Logic ─────────────────────────────────────────────────

let finalTwitterData  = null;
let activeTwitterJobId = null;
let activeTwitterSSE   = null;

function resetTwitterUI() {
    const submitBtn = document.getElementById('twitter-submit-btn');
    const stopBtn   = document.getElementById('twitter-stop-btn');
    submitBtn.disabled = false;
    submitBtn.classList.remove('btn-loading');
    stopBtn.style.display = 'none';
    activeTwitterJobId = null;
    if (activeTwitterSSE) { activeTwitterSSE.close(); activeTwitterSSE = null; }
}

// Stop button handler
document.getElementById('twitter-stop-btn').addEventListener('click', async () => {
    if (!activeTwitterJobId) return;
    const stopBtn     = document.getElementById('twitter-stop-btn');
    const statusBadge = document.getElementById('twitter-status-badge');
    const jsonOutput  = document.getElementById('twitter-json-output');

    stopBtn.disabled  = true;
    stopBtn.textContent = 'Stopping...';

    try {
        await fetch(`/api/twitter/jobs/${activeTwitterJobId}/cancel`, { method: 'DELETE' });
    } catch (_) {}

    jsonOutput.textContent += `\n[STOPPED] Job cancelled by user.`;
    statusBadge.className   = 'badge error';
    statusBadge.textContent = 'Stopped';

    // Show export if we have partial data
    const exportSection = document.getElementById('twitter-export-section');
    const tweetCountEl  = document.getElementById('twitter-tweet-count');
    if (finalTwitterData && finalTwitterData.length > 0) {
        tweetCountEl.textContent = `🐦 ${finalTwitterData.length} tweet${finalTwitterData.length !== 1 ? 's' : ''} collected (partial)`;
        if (exportSection) exportSection.style.display = 'flex';
    }
    resetTwitterUI();
});

document.getElementById('extract-twitter-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const urlInput      = document.getElementById('twitter-url').value;
    const depthInput    = document.getElementById('twitter-depth').value;
    const maxPostsInput = document.getElementById('twitter-max-posts').value;
    const maxDuration   = document.getElementById('twitter-max-duration').value;
    const submitBtn     = document.getElementById('twitter-submit-btn');
    const stopBtn       = document.getElementById('twitter-stop-btn');
    const statusBadge   = document.getElementById('twitter-status-badge');
    const jsonOutput    = document.getElementById('twitter-json-output');
    const exportSection = document.getElementById('twitter-export-section');
    const tweetCountEl  = document.getElementById('twitter-tweet-count');

    finalTwitterData   = null;
    activeTwitterJobId = null;

    submitBtn.disabled = true;
    submitBtn.classList.add('btn-loading');
    stopBtn.style.display = 'flex';
    stopBtn.disabled      = false;
    stopBtn.innerHTML     = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop';
    statusBadge.className    = 'badge processing';
    statusBadge.textContent  = 'Scraping';
    jsonOutput.style.color   = '#FFF';

    const durationLabel = maxDuration === '0' ? 'No limit' : `${maxDuration}h max`;
    jsonOutput.textContent = `Connecting to Twitter scraper cluster...\nSeed: ${urlInput}\nDepth: ${depthInput}  |  Max Posts: ${maxPostsInput}  |  Duration: ${durationLabel}\n${'─'.repeat(50)}\n`;
    if (exportSection) exportSection.style.display = 'none';

    try {
        const response = await fetch('/api/twitter/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url:               urlInput,
                depth:             parseInt(depthInput, 10),
                maxTweetsPerUrl:   parseInt(maxPostsInput, 10),
                maxDurationHours:  parseFloat(maxDuration),
            })
        });

        const config = await response.json();
        if (!response.ok) throw new Error(config.error || 'Server rejected Twitter scrape request');

        const jobId = config.jobId;
        activeTwitterJobId = jobId;
        jsonOutput.textContent += `[SYSTEM] Job ${jobId} started. Streaming progress...\n`;

        try {
            activeTwitterSSE = new EventSource(`/api/twitter/status?jobId=${jobId}`);

            activeTwitterSSE.onmessage = function (event) {
                const data = JSON.parse(event.data);

                if (data.type === 'progress') {
                    const prefix = data.status ? `[${data.status.toUpperCase()}] ` : '';
                    jsonOutput.textContent += `${prefix}${data.message}\n`;
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;

                    // Show live count during scraping
                    const match = data.message.match(/(\d+) unique tweet/);
                    if (match) tweetCountEl.textContent = `🐦 ${match[1]} tweets so far...`;

                } else if (data.type === 'result') {
                    finalTwitterData = data.data;
                    const count = Array.isArray(data.data) ? data.data.length : 0;

                    statusBadge.className  = 'badge success';
                    statusBadge.textContent = 'Complete';
                    jsonOutput.style.color  = '#DCCCAC';
                    jsonOutput.textContent += `\n${'═'.repeat(50)}\n🐦 SCRAPED ${count} TWEETS\n${'═'.repeat(50)}\n`;
                    jsonOutput.textContent += JSON.stringify(data.data, null, 2);
                    tweetCountEl.textContent = `🐦 ${count} tweet${count !== 1 ? 's' : ''} collected`;

                    resetTwitterUI();
                    if (exportSection) exportSection.style.display = 'flex';
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;

                } else if (data.type === 'error') {
                    throw new Error(data.error);
                }
            };

            activeTwitterSSE.onerror = function () {
                if (activeTwitterSSE && activeTwitterSSE.readyState === EventSource.CLOSED) return;
                statusBadge.className  = 'badge error';
                statusBadge.textContent = 'Stream Error';
                jsonOutput.style.color  = '#E46464';
                jsonOutput.textContent += `\n[SSE ERROR] Connection to server lost.`;
                resetTwitterUI();
            };

        } catch (streamError) {
            statusBadge.className  = 'badge error';
            statusBadge.textContent = 'Failed';
            jsonOutput.style.color  = '#E46464';
            jsonOutput.textContent += `\n[FATAL] ${streamError.message}`;
            resetTwitterUI();
        }

    } catch (networkError) {
        statusBadge.className  = 'badge error';
        statusBadge.textContent = 'Network Error';
        jsonOutput.style.color  = '#E46464';
        jsonOutput.textContent += `\n[NETWORK ERROR] ${networkError.message}`;
        resetTwitterUI();
    }
});

// ── Twitter Export Helpers ───────────────────────────────────────────────────

function initiateTwitterDownload(dataArray, type = 'json') {
    if (!dataArray || dataArray.length === 0) {
        alert('No tweet data available to export.');
        return;
    }
    if (type === 'json') {
        const blob = new Blob([JSON.stringify(dataArray, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `twitter_data_${Date.now()}.json`;
        link.click();
    } else {
        // Flatten tweet objects for CSV
        const flat = dataArray.map(t => ({
            tweet_url:    t.tweetUrl   || '',
            source_url:   t.sourceUrl  || '',
            depth:        t.depth      || 1,
            handle:       t.handle     || '',
            display_name: t.displayName || '',
            posted_at:    t.postedAt   || '',
            text:         t.text       || '',
            likes:        t.stats?.like         || '',
            retweets:     t.stats?.retweet      || '',
            replies:      t.stats?.reply        || '',
            views:        t.stats?.views        || '',
            media:        Array.isArray(t.media) ? t.media.join(' | ') : '',
            quote_tweet:  t.quoteTweet || ''
        }));
        const csvString = Papa.unparse(flat);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `twitter_data_${Date.now()}.csv`;
        link.click();
    }
}

document.getElementById('btn-export-twitter-json').addEventListener('click', () => initiateTwitterDownload(finalTwitterData, 'json'));
document.getElementById('btn-export-twitter-csv').addEventListener('click',  () => initiateTwitterDownload(finalTwitterData, 'csv'));

// ── Quora Scraper Logic ───────────────────────────────────────────────────────

const quoraDepthSlider = document.getElementById('quora-depth');
const quoraDepthLabel  = document.getElementById('quora-depth-label');
if (quoraDepthSlider) {
    quoraDepthSlider.addEventListener('input', () => {
        quoraDepthLabel.textContent = quoraDepthSlider.value;
        quoraDepthLabel.style.transform = 'scale(1.2)';
        setTimeout(() => { quoraDepthLabel.style.transform = 'scale(1)'; }, 150);
    });
}

let finalQuoraData  = null;
let activeQuoraJobId = null;
let activeQuoraSSE   = null;

function resetQuoraUI() {
    const submitBtn = document.getElementById('quora-submit-btn');
    const stopBtn   = document.getElementById('quora-stop-btn');
    submitBtn.disabled = false;
    submitBtn.classList.remove('btn-loading');
    stopBtn.style.display = 'none';
    activeQuoraJobId = null;
    if (activeQuoraSSE) { activeQuoraSSE.close(); activeQuoraSSE = null; }
}

document.getElementById('quora-stop-btn').addEventListener('click', async () => {
    if (!activeQuoraJobId) return;
    const stopBtn     = document.getElementById('quora-stop-btn');
    const statusBadge = document.getElementById('quora-status-badge');
    const jsonOutput  = document.getElementById('quora-json-output');

    stopBtn.disabled  = true;
    stopBtn.textContent = 'Stopping...';

    try {
        await fetch(`/api/quora/jobs/${activeQuoraJobId}/cancel`, { method: 'DELETE' });
    } catch (_) {}

    jsonOutput.textContent += `\n[STOPPED] Job cancelled by user.`;
    statusBadge.className   = 'badge error';
    statusBadge.textContent = 'Stopped';

    const exportSection = document.getElementById('quora-export-section');
    const postCountEl   = document.getElementById('quora-post-count');
    if (finalQuoraData && finalQuoraData.length > 0) {
        postCountEl.textContent = `📝 ${finalQuoraData.length} post${finalQuoraData.length !== 1 ? 's' : ''} collected (partial)`;
        if (exportSection) exportSection.style.display = 'flex';
    }
    resetQuoraUI();
});

document.getElementById('extract-quora-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const urlInput      = document.getElementById('quora-url').value;
    const depthInput    = document.getElementById('quora-depth').value;
    const maxDuration   = document.getElementById('quora-max-duration').value;
    const submitBtn     = document.getElementById('quora-submit-btn');
    const stopBtn       = document.getElementById('quora-stop-btn');
    const statusBadge   = document.getElementById('quora-status-badge');
    const jsonOutput    = document.getElementById('quora-json-output');
    const exportSection = document.getElementById('quora-export-section');
    const postCountEl   = document.getElementById('quora-post-count');

    finalQuoraData     = null;
    activeQuoraJobId   = null;

    submitBtn.disabled = true;
    submitBtn.classList.add('btn-loading');
    stopBtn.style.display = 'flex';
    stopBtn.disabled      = false;
    stopBtn.innerHTML     = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop';
    statusBadge.className    = 'badge processing';
    statusBadge.textContent  = 'Scraping';
    jsonOutput.style.color   = '#FFF';

    const durationLabel = maxDuration === '0' ? 'No limit' : `${maxDuration}h max`;
    jsonOutput.textContent = `Connecting to Quora scraper cluster...\nSeed: ${urlInput}\nDepth: ${depthInput}  |  Duration: ${durationLabel}\n${'─'.repeat(50)}\n`;
    if (exportSection) exportSection.style.display = 'none';

    try {
        const response = await fetch('/api/quora/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url:               urlInput,
                depth:             parseInt(depthInput, 10),
                maxDurationHours:  parseFloat(maxDuration),
            })
        });

        const config = await response.json();
        if (!response.ok) throw new Error(config.error || 'Server rejected Quora scrape request');

        const jobId = config.jobId;
        activeQuoraJobId = jobId;
        jsonOutput.textContent += `[SYSTEM] Job ${jobId} started. Streaming progress...\n`;

        try {
            activeQuoraSSE = new EventSource(`/api/quora/status?jobId=${jobId}`);

            activeQuoraSSE.onmessage = function (event) {
                const data = JSON.parse(event.data);

                if (data.type === 'progress') {
                    const prefix = data.status ? `[${data.status.toUpperCase()}] ` : '';
                    jsonOutput.textContent += `${prefix}${data.message}\n`;
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;

                    const match = data.message.match(/total: (\d+)/);
                    if (match) postCountEl.textContent = `📝 ${match[1]} posts so far...`;

                } else if (data.type === 'result') {
                    finalQuoraData = data.data;
                    const count = Array.isArray(data.data) ? data.data.length : 0;

                    statusBadge.className  = 'badge success';
                    statusBadge.textContent = 'Complete';
                    jsonOutput.style.color  = '#DCCCAC';
                    jsonOutput.textContent += `\n${'═'.repeat(50)}\n📝 SCRAPED ${count} POSTS\n${'═'.repeat(50)}\n`;
                    jsonOutput.textContent += JSON.stringify(data.data, null, 2);
                    postCountEl.textContent = `📝 ${count} post${count !== 1 ? 's' : ''} collected`;

                    resetQuoraUI();
                    if (exportSection) exportSection.style.display = 'flex';
                    jsonOutput.parentElement.scrollTop = jsonOutput.parentElement.scrollHeight;

                } else if (data.type === 'error') {
                    throw new Error(data.error);
                }
            };

            activeQuoraSSE.onerror = function () {
                if (activeQuoraSSE && activeQuoraSSE.readyState === EventSource.CLOSED) return;
                statusBadge.className  = 'badge error';
                statusBadge.textContent = 'Stream Error';
                jsonOutput.style.color  = '#E46464';
                jsonOutput.textContent += `\n[SSE ERROR] Connection to server lost.`;
                resetQuoraUI();
            };

        } catch (streamError) {
            statusBadge.className  = 'badge error';
            statusBadge.textContent = 'Failed';
            jsonOutput.style.color  = '#E46464';
            jsonOutput.textContent += `\n[FATAL] ${streamError.message}`;
            resetQuoraUI();
        }

    } catch (networkError) {
        statusBadge.className  = 'badge error';
        statusBadge.textContent = 'Network Error';
        jsonOutput.style.color  = '#E46464';
        jsonOutput.textContent += `\n[NETWORK ERROR] ${networkError.message}`;
        resetQuoraUI();
    }
});

function initiateQuoraDownload(dataArray, type = 'json') {
    if (!dataArray || dataArray.length === 0) {
        alert('No Quora data available to export.');
        return;
    }
    if (type === 'json') {
        const blob = new Blob([JSON.stringify(dataArray, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `quora_data_${Date.now()}.json`;
        link.click();
    } else {
        const flat = dataArray.map(t => ({
            url:          t.url        || '',
            source_url:   t.sourceUrl  || '',
            depth:        t.depth      || 1,
            author:       t.author     || '',
            title:        t.title      || '',
            content:      t.content    || '',
            upvotes:      t.upvotes    || ''
        }));
        const csvString = Papa.unparse(flat);
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `quora_data_${Date.now()}.csv`;
        link.click();
    }
}

document.getElementById('btn-export-quora-json').addEventListener('click', () => initiateQuoraDownload(finalQuoraData, 'json'));
document.getElementById('btn-export-quora-csv').addEventListener('click',  () => initiateQuoraDownload(finalQuoraData, 'csv'));


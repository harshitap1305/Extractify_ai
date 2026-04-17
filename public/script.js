let finalExtractedData = null;

// --- Dashboard Navigation Logic ---
const navNewCrawl = document.getElementById('nav-new-crawl');
const navNewsCrawl = document.getElementById('nav-news-crawl');
const navHistory = document.getElementById('nav-history');

const viewCrawl = document.getElementById('view-crawl');
const viewNews = document.getElementById('view-news');
const viewHistory = document.getElementById('view-history');
const historyContainer = document.getElementById('history-container');

function switchView(viewName) {
    [navNewCrawl, navNewsCrawl, navHistory].forEach(el => el.classList.remove('active'));
    viewCrawl.style.display = 'none';
    viewNews.style.display = 'none';
    viewHistory.style.display = 'none';

    if (viewName === 'crawl') {
        navNewCrawl.classList.add('active');
        viewCrawl.style.display = 'grid';
    } else if (viewName === 'news') {
        navNewsCrawl.classList.add('active');
        viewNews.style.display = 'grid';
    } else if (viewName === 'history') {
        navHistory.classList.add('active');
        viewHistory.style.display = 'grid';
        loadJobHistory();
    }
}

navNewCrawl.addEventListener('click', () => switchView('crawl'));
navNewsCrawl.addEventListener('click', () => switchView('news'));
navHistory.addEventListener('click', () => switchView('history'));

// Duplicate extraction form bindings specifically for 'extract-news-form'
document.getElementById('extract-news-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Logic for news extraction
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
        const response = await fetch('/api/jobs');
        const jobs = await response.json();

        if (!jobs || jobs.length === 0) {
            historyContainer.innerHTML = '<span style="color: var(--primary); opacity: 0.8;">No completed jobs found. Initialize your first extraction!</span>';
            return;
        }

        historyContainer.innerHTML = jobs.map(job => `
            <div style="background: rgba(255,255,255,0.6); border: 1px solid var(--glass-border); padding: 1.5rem; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                <div style="display: flex; flex-direction: column; gap: 0.5rem; max-width: 60%;">
                    <h4 style="color: var(--text-dark); font-family: 'Inter', sans-serif;">${job.url}</h4>
                    <pre style="padding: 0; background: transparent; color: var(--primary); font-size: 0.85rem; max-height: unset; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Goal: ${job.prompt}</pre>
                    <span style="font-size: 0.8rem; color: #888;">Status: <b>${job.status.toUpperCase()}</b> • Scraped ${new Date(job.created_at).toLocaleString()}</span>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button onclick="downloadHistoryJSON('${job.id}')" class="btn secondary" style="padding: 0.6rem 1rem; font-size: 0.85rem;">Download JSON</button>
                    <button onclick="downloadHistoryCSV('${job.id}')" class="btn outline" style="padding: 0.6rem 1rem; font-size: 0.85rem; border: 2px solid var(--primary-light) !important;">Download CSV</button>
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
document.getElementById('btn-export-csv').addEventListener('click', () => initiateDownload(finalExtractedData, 'csv'));

// Download Handlers (News Scraper Pane)
document.getElementById('btn-export-news-json').addEventListener('click', () => initiateDownload(finalNewsExtractedData, 'json'));
document.getElementById('btn-export-news-csv').addEventListener('click', () => initiateDownload(finalNewsExtractedData, 'csv'));

// Download Handlers (History Async Pane)
window.downloadHistoryJSON = async (jobId) => {
    const res = await fetch(`/api/jobs/${jobId}/export`);
    initiateDownload(await res.json(), 'json');
};
window.downloadHistoryCSV = async (jobId) => {
    const res = await fetch(`/api/jobs/${jobId}/export`);
    initiateDownload(await res.json(), 'csv');
};

require('dotenv').config();
const { Workflow } = require('./src/index');

async function main() {
    console.log("=== Extractify AI: Web Scraping Pipeline ===\n");

    if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_api_key_here') {
        console.error("ERROR: Please set GROQ_API_KEY in your .env file!");
        process.exit(1);
    }

    // Phase 1: The "Frontend" (The Developer Request)
    // Step 1: Giving the Command
    const targetUrl = 'https://news.ycombinator.com/';
    const prompt = 'Extract the top 3 news articles. Return a JSON object with a key "articles", which is an array of objects. Each object should have a "title" and a "link".';

    console.log(`[Request] URL: ${targetUrl}`);
    console.log(`[Request] Prompt: "${prompt}"\n`);

    // Phase 2: The "Backend" (The Extractify Engine)
    const engine = new Workflow();

    // Phase 3: Streaming the results via callback
    console.log("--- Engine Output ---");
    const result = await engine.runPipeline(targetUrl, prompt, (progress) => {
        // Step 8: Streaming the results
        console.log(`[${progress.status.toUpperCase()}] ${progress.message}`);
        if (progress.data) {
            console.log(`[DATA] Got structured result!`);
        }
    });

    if (result.success) {
        console.log("\n=== Final Extracted JSON Output ===");
        console.log(JSON.stringify(result.data, null, 2));
    } else {
        console.error("\n=== Extraction Failed ===");
    }
}

main();

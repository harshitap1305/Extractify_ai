const { PuppeteerCrawler } = require('crawlee');
const Cleaner = require('./src/Cleaner');

async function run() {
    const crawler = new PuppeteerCrawler({
        maxConcurrency: 1,
        launchContext: { launchOptions: { args: ['--no-sandbox'] } },
        requestHandler: async ({ page, request }) => {
            console.log("Waiting for network idle...");

            // Indian express has infinite scroll. Let's scroll a few times.
            for (let i = 0; i < 5; i++) {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                await page.waitForTimeout(1000);
            }

            const html = await page.content();
            console.log("HTML length:", html.length);
            const rawText = Cleaner.clean(html, request.url);
            console.log("Cleaner text length:", rawText.length);
            console.log("Sample text end:", rawText.substring(Math.max(0, rawText.length - 1000)));
        }
    });

    await crawler.run(['https://indianexpress.com/article/world/iran-us-israel-war-live-updates-lebanon-attack-hezbollah-ceasefire-10626787/?ref=breaking_hp']);
}

run();

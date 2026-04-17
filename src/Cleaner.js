const cheerio = require('cheerio');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

class Cleaner {
    static clean(rawHtml, url = "http://localhost") {
        const $ = cheerio.load(rawHtml);
        
        // Deterministic Extraction (Title / Date) defaults
        let title = $('title').text() || '';
        let date = $('meta[property="article:published_time"]').attr('content') || 
                   $('meta[name="pubdate"]').attr('content') || '';
        let content = '';

        try {
            const doc = new JSDOM(rawHtml, { url });
            const reader = new Readability(doc.window.document);
            const article = reader.parse();

            if (article && article.textContent) {
                // Successfully parsed with Mozilla's native Trafilatura-equivalent engine!
                if (article.title) title = article.title;
                if (article.publishedTime) date = article.publishedTime;
                content = article.textContent.replace(/\t/g, ' ').replace(/ +/g, ' ').replace(/\n\s*\n/g, '\n').trim();
            }
        } catch (e) {
            console.error("[Cleaner] Error using Readability, falling back to manual Cheerio...", e.message);
        }

        if (!content) {
            // --- Fallback Mechanism ---
            $('script, style, noscript, svg, nav, footer, header, iframe, link, meta, form, p[class*="cookie"]').remove();
            $('*').each((i, el) => {
                const href = $(el).attr('href');
                el.attribs = {};
                if (href && el.tagName === 'a') {
                    $(el).attr('href', href);
                }
            });
            $('p, div, h1, h2, h3, h4, h5, h6, span, article').each((i, el) => {
                if (!$(el).find('table, ul, ol, li, tr, td').length) {
                    $(el).replaceWith(`\n${$(el).text().trim()}\n`);
                }
            });
            content = $('body').text() || $.html();
            content = content.replace(/\t/g, ' ').replace(/ +/g, ' ').replace(/\n\s*\n/g, '\n').trim();
        }

        return {
            title: title.trim().substring(0, 300),
            date: date.trim().substring(0, 100),
            body: content,
            raw_text: content // standard reference
        };
    }

    static extractLinks(rawHtml, baseUrl) {
        const $ = cheerio.load(rawHtml);
        const links = new Set();
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                try {
                    const urlObj = new URL(href, baseUrl);
                    // Standard deep crawling restriction: stick to same hostname to avoid crawling the entire internet
                    const baseObj = new URL(baseUrl);
                    if ((urlObj.protocol === 'http:' || urlObj.protocol === 'https:') && urlObj.hostname === baseObj.hostname) {
                        links.add(urlObj.href.split('#')[0]); // ignore hash paths
                    }
                } catch (e) { }
            }
        });
        return Array.from(links);
    }
}

module.exports = Cleaner;

const Groq = require('groq-sdk');
const Bottleneck = require('bottleneck');

class SinglePromptExtractor {
    constructor(options = {}) {
        this.groq = new Groq({
            apiKey: process.env.GROQ_API_KEY,
        });
        this.model = options.model || 'llama-3.3-70b-versatile';

        // Llama-3.3-70b-versatile Free Tier Limits: ~30 RPM
        // Bottleneck intercepts fast deep crawls, queues them into memory, and feeds them locally at 2000ms pace
        this.limiter = new Bottleneck({
            maxConcurrent: 2,
            minTime: 3000 // Ensure at least 3 seconds between jobs (30 jobs per minute)
        });

        // 429 API Rate Limit Exponential Backoff setup
        this.limiter.on("failed", async (error, jobInfo) => {
            const isRateLimit = error.status === 429 || (error.error && error.error.error && error.error.error.code === 'rate_limit_exceeded');

            if (jobInfo.retryCount < 1 && isRateLimit) {
                console.warn(`[Extractor] Groq API 429 Rate Limit Hit. Retrying attempt ${jobInfo.retryCount + 1} in 5 seconds...`);
                return 5000; // wait 5.0 seconds before retrying this specific extraction safely
            }
        });
    }

    async extract(prompt, text) {
        // Enqueue the extraction task through Bottleneck natively
        return this.limiter.schedule(() => this._performExtract(prompt, text));
    }

    async _performExtract(prompt, text) {
        const systemInstruction = `
      You are an expert data extraction engine. 
      You will be provided with cleaned text extracted from a webpage, and a specific extraction instruction.
      Your task is to follow the instruction strictly and extract the required information from the text.
      
      CRITICAL: You MUST respond ONLY with valid JSON. 
      Do not include any conversational filler. Do not use markdown code blocks like \`\`\`json. 
      If you cannot find the requested information, return an empty JSON object {} or an empty array [] if a list was requested.
      
      Ensure your output is a structured JSON representation of the request.
    `;

        const userMessage = `
      --- INSTRUCTION ---
      ${prompt}

      --- WEBPAGE TEXT ---
      ${text}
    `;

        try {
            const completion = await this.groq.chat.completions.create({
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: userMessage }
                ],
                model: this.model,
                temperature: 0.1, // Low temperature for deterministic output
                response_format: { type: 'json_object' } // Enforce JSON response
            });

            const responseContent = completion.choices[0]?.message?.content;

            try {
                return JSON.parse(responseContent);
            } catch (parseError) {
                console.error("[Extractor] Failed to parse JSON. Raw LLM output:", responseContent);
                throw new Error("Extractor returned invalid JSON");
            }
        } catch (error) {
            console.error("[Extractor] Groq API Error:", error.message);
            throw error;
        }
    }
}

module.exports = SinglePromptExtractor;

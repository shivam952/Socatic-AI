/**
 * Socratic AI — OpenRouter HTTP Client
 *
 * Shared LLM client used by both the Detector pipeline and the constraint
 * suggester. Extracted so every LLM call gets the same timeout, error handling,
 * and JSON mode behaviour without duplication.
 */
import * as https from 'https';

const OPENROUTER_TIMEOUT_MS = 30_000; // 30s hard timeout
// Guard against memory bombs from huge/unexpected responses.
// A well-formed completion response is <50KB; 2MB is a hard ceiling.
const MAX_RESPONSE_BYTES = 2_000_000; // 2MB

/**
 * Call OpenRouter's chat completions API.
 * Returns the raw response body string on success.
 * Rejects on timeout (30s), HTTP errors, or network failures.
 */
export function callOpenRouter(
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number
): Promise<string> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
        });

        const timeout = setTimeout(() => {
            req.destroy();
            reject(new Error('OpenRouter request timed out after 30s'));
        }, OPENROUTER_TIMEOUT_MS);

        const options: https.RequestOptions = {
            hostname: 'openrouter.ai',
            port: 443,
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://socratic-ai.dev',
                'X-Title': 'Socratic AI',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            let responseBytes = 0;
            let tooLarge = false;

            res.on('data', (chunk: Buffer) => {
                responseBytes += chunk.length;
                if (responseBytes > MAX_RESPONSE_BYTES) {
                    tooLarge = true;
                    req.destroy();
                    clearTimeout(timeout);
                    reject(new Error('OpenRouter response exceeded 2MB size limit'));
                    return;
                }
                data += chunk;
            });

            res.on('end', () => {
                if (tooLarge) { return; } // Already rejected above
                clearTimeout(timeout);
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    // Do NOT include response body in error — it may echo back
                    // request headers (including the Authorization key) in some
                    // error formats from upstream providers.
                    reject(new Error(`OpenRouter HTTP ${res.statusCode} — check your API key and model name`));
                }
            });
        });

        req.on('error', (err) => { clearTimeout(timeout); reject(err); });
        req.write(body);
        req.end();
    });
}

/**
 * Helper: extract the message content from an OpenRouter response.
 * Strips markdown code fences if the LLM wraps JSON in ```json ... ```
 * (common even with response_format: json_object on some models).
 * Returns null if the response shape is unexpected.
 */
export function extractContent(responseText: string): string | null {
    try {
        const data = JSON.parse(responseText);
        const raw: string | undefined = data.choices?.[0]?.message?.content;
        if (!raw) { return null; }

        // Strip markdown fences — some models return ```json\n{...}\n```
        return raw
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
    } catch {
        return null;
    }
}

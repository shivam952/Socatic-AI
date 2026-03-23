/**
 * Socratic AI — LLM Client (OpenRouter)
 * 
 * 🏗️ ARCHITECTURE NOTE: The Socratic Prompt
 * 
 * The system prompt is the soul of the product. It tells the LLM:
 * - You are NOT a coding assistant. You do NOT write code.
 * - You are a senior engineer who QUESTIONS the developer's approach.
 * - You ask ONE specific, probing question — not a lecture.
 * - If nothing is wrong, you say LGTM and shut up.
 * 
 * This is the opposite of every other AI tool. Most AI tools
 * try to be as helpful as possible. Socratic tries to be as
 * CHALLENGING as possible — but only when it matters.
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { AnalysisContext } from './context';

export interface SocraticResponse {
    /** 'lgtm' | 'warning' | 'critical' */
    severity: string;
    /** The probing question or observation */
    message: string;
    /** Why this matters (shown on "Tell me more") */
    reasoning?: string;
    /** Alternative approaches to consider */
    alternatives?: string[];
}

const SYSTEM_PROMPT = `You are Socratic AI — a senior engineer who reviews a developer's approach to their project.

YOUR ROLE:
- You QUESTION the developer's thinking. You do NOT write code.
- You look for blind spots, flawed assumptions, and scope mismatches.
- You compare what the developer is DOING against their stated GOAL.

YOUR RULES:
1. Identify ONE specific concern about the current code change relative to the project goal.
2. Frame it as a question, not a command. "Have you considered..." not "You should..."
3. Be SPECIFIC — reference actual code, file names, or patterns you see.
4. If nothing concerning, respond with severity "lgtm". Don't invent problems.
5. NEVER suggest entire rewrites. NEVER dump 20 suggestions. ONE question only.
6. Think like a senior engineer doing a quick desk-check, not a formal code review.

RESPOND IN THIS EXACT JSON FORMAT:
{
  "severity": "lgtm" | "warning" | "critical",
  "message": "Your one probing question (2-3 sentences max)",
  "reasoning": "Brief explanation of why this matters (1-2 sentences)",
  "alternatives": ["Alternative approach 1", "Alternative approach 2"]
}

SEVERITY GUIDE:
- "lgtm": Nothing concerning. Code aligns with goal.
- "warning": Something worth thinking about. Not blocking, but could cause issues later.
- "critical": Clear misalignment with the goal, or a methodological flaw that will waste significant time.

REMEMBER: You are not here to be helpful. You are here to be CHALLENGING — but only when warranted.`;

function buildUserPrompt(ctx: AnalysisContext): string {
    let prompt = `PROJECT GOAL:\n${ctx.goal.goal}\n`;

    if (ctx.goal.context) {
        prompt += `\nADDITIONAL CONTEXT:\n${ctx.goal.context}\n`;
    }

    prompt += `\nPROJECT STRUCTURE:\n${ctx.projectStructure}\n`;

    prompt += `\nFILE JUST SAVED: ${ctx.changedFile.relativePath} (${ctx.changedFile.language})`;
    prompt += `\n\nFILE CONTENT:\n\`\`\`${ctx.changedFile.language}\n${ctx.changedFile.content}\n\`\`\`\n`;

    if (ctx.recentWarnings.length > 0) {
        prompt += `\nPREVIOUS WARNINGS (avoid repeating these):\n`;
        ctx.recentWarnings.forEach((w, i) => {
            prompt += `${i + 1}. ${w}\n`;
        });
    }

    prompt += `\nAnalyze this code change relative to the project goal. Find ONE blind spot, or say LGTM.`;
    return prompt;
}

export async function analyzeCode(ctx: AnalysisContext): Promise<SocraticResponse> {
    const config = vscode.workspace.getConfiguration('socratic');
    const apiKey = config.get<string>('apiKey', '');
    const model = config.get<string>('model', 'anthropic/claude-sonnet-4');

    if (!apiKey) {
        return {
            severity: 'warning',
            message: 'Socratic AI needs an API key. Run "Socratic: Set API Key" to configure.',
        };
    }

    const requestBody = JSON.stringify({
        model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(ctx) },
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' },
    });

    try {
        const responseText = await httpPost(
            'openrouter.ai',
            '/api/v1/chat/completions',
            requestBody,
            apiKey
        );

        const data = JSON.parse(responseText);
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            return { severity: 'lgtm', message: 'Analysis complete — no concerns.' };
        }

        try {
            const parsed = JSON.parse(content) as SocraticResponse;
            return parsed;
        } catch {
            // LLM didn't return valid JSON, wrap the text
            return {
                severity: 'warning',
                message: content,
            };
        }
    } catch (err: any) {
        console.error('Socratic LLM error:', err);
        return {
            severity: 'warning',
            message: `Analysis failed: ${err.message || 'Unknown error'}. Check your API key and network.`,
        };
    }
}

/**
 * Simple HTTPS POST (no external dependencies needed).
 */
function httpPost(host: string, path: string, body: string, apiKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            hostname: host,
            port: 443,
            path,
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
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`API error ${res.statusCode}: ${data.slice(0, 200)}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

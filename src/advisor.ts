/**
 * Socratic AI — Advisor Stage (Track 1.4)
 *
 * Runs only when the user clicks "Tell me more" on a warning.
 * Not part of the automatic pipeline — user-initiated, so no latency cost.
 *
 * The Detector asks the right question. The Advisor answers it:
 * "What should I do RIGHT NOW, specifically in my code?"
 *
 * Key difference from the Detector:
 *   - Detector sees: diff evidence + memory
 *   - Advisor sees: FULL file content + memory + the Detector's finding
 *   - Advisor is PRESCRIPTIVE ("do X") not interrogative ("should you do X?")
 *   - Advisor references actual variable names, thresholds, function names
 */
import * as fs from 'fs';
import * as path from 'path';
import { callOpenRouter, extractContent } from './openrouter';
import { getGoal } from './goal';
import { loadMemory } from './memory';
import { logError } from './notifications';

// ─── Token budget ─────────────────────────────────────────────────────────────
const MAX_FILE_CHARS = 3_000;   // ~750 tokens — enough to see the full relevant code
const MAX_OUTPUT_TOKENS = 800;  // Room for a detailed 5-step action plan

// ─── System prompt ────────────────────────────────────────────────────────────

const ADVISOR_SYSTEM_PROMPT = `You are a senior engineer giving a code review.
A concern has already been identified and explained to the developer.
Your job is NOT to re-explain the concern — skip directly to the fix.

Your output: a concrete, numbered action plan (3–5 steps) that the developer
can execute in the next 30 minutes to stay on track with their milestone.

Rules:
1. Reference ACTUAL code: variable names, function names, threshold values, 
   file names — whatever appears in the code you're given.
2. Each step must be actionable RIGHT NOW. No long-term advice.
3. Stay focused on the CURRENT MILESTONE — not the finished product.
4. If you see something misconfigured or suboptimal in the code, name it exactly.
5. End with one sentence on what to measure to know if the fix is working.
6. Be direct. No hedging. No "you might consider." Just numbered steps.

Respond in plain text — no markdown headers, no bullets, just numbered steps.`;

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Run the Advisor for a specific warning. Reads the actual file content
 * from disk so it can reference real variable names and threshold values.
 *
 * Returns a formatted action plan string, or a fallback message on failure.
 */
export async function runAdvisor(
    issueType: string,
    warningMessage: string,
    filePath: string,
    apiKey: string,
    model: string
): Promise<string> {
    const goal = getGoal();
    if (!goal) {
        return 'No project goal set — run "Socratic: Set Project Goal" to enable detailed guidance.';
    }

    const memory = loadMemory(goal);

    // Read the actual file content so the Advisor can reference real code
    let fileContent = '';
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        fileContent = raw.length > MAX_FILE_CHARS
            ? raw.slice(0, MAX_FILE_CHARS) + '\n...(file truncated)'
            : raw;
    } catch {
        fileContent = '(file could not be read)';
    }

    const fileName = path.basename(filePath);

    const userPrompt = [
        `CONCERN ALREADY SHOWN TO DEVELOPER:`,
        `Issue type: ${issueType}`,
        `Message: ${warningMessage}`,
        ``,
        `PROJECT CONTEXT:`,
        `Goal: ${goal.goal}`,
        `Current milestone: ${goal.milestone}`,
        `Success metric: ${goal.success_metric}`,
        `Time horizon: ${goal.time_horizon}`,
        goal.context ? `Tech context: ${goal.context}` : '',
        ``,
        memory.constraints.constraints.length > 0
            ? `Constraints:\n${memory.constraints.constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`
            : '',
        ``,
        `ACTUAL FILE: ${fileName}`,
        `${'─'.repeat(40)}`,
        fileContent,
        `${'─'.repeat(40)}`,
        ``,
        `What should the developer do RIGHT NOW to stay on track with their milestone?`,
        `Give 3–5 numbered steps. Reference actual code from the file above.`,
    ].filter(Boolean).join('\n');

    try {
        const responseText = await callOpenRouter(
            apiKey,
            model,
            ADVISOR_SYSTEM_PROMPT,
            userPrompt,
            MAX_OUTPUT_TOKENS
        );

        const content = extractContent(responseText);
        if (!content) {
            return 'Advisor returned no guidance. Try again or check your API key.';
        }

        return content.trim();
    } catch (err: any) {
        logError(`Advisor call failed: ${err.message}`);
        return `Advisor unavailable: ${err.message}`;
    }
}

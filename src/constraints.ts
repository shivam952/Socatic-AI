/**
 * Socratic AI — Constraint Inference (Track 1.1)
 *
 * Solves the cold-start problem: without constraints, the Detector defaults
 * to "lgtm" for everything. Manual constraint entry is too much friction.
 *
 * After goal setup, this module:
 *   1. Calls the LLM to generate 4 candidate constraints from the goal text
 *   2. Shows a quick-pick (all pre-selected — opt-out model)
 *   3. Writes accepted constraints to constraints.json
 *
 * The entire flow is optional and failure-tolerant. If the LLM call fails
 * or the user dismisses the quick-pick, goal setup still completes normally.
 */
import * as vscode from 'vscode';
import { GoalMemory } from './goal';
import { addConstraint } from './memory';
import { callOpenRouter, extractContent } from './openrouter';
import { logError } from './notifications';

// ─── System prompt ────────────────────────────────────────────────────────────

const CONSTRAINT_SYSTEM_PROMPT = `You are a senior engineer doing a project intake review.
Given a developer's goal, milestone, and context, generate the top 4 architectural
constraints they should commit to for this stage of the project.

Each constraint MUST:
- Name the SPECIFIC technology or pattern being restricted
  BAD:  "No cloud services"
  GOOD: "No cloud LLM inference (OpenAI, Anthropic API) until local model quality is validated"
- State WHY it's premature at this specific milestone
  BAD:  "No databases"
  GOOD: "No managed vector databases (Pinecone, Weaviate) before FAISS retrieval quality is proven on the eval set"
- Be falsifiable — someone looking at the codebase should be able to tell if it's violated
  BAD:  "Keep dependencies minimal"
  GOOD: "No task queues or message brokers (Celery, RabbitMQ, Kafka) before the core pipeline handles synchronous requests"

Start each constraint with "No" or "Only" or "Must" for clarity.

Respond with ONLY a JSON object — no markdown, no code fences, no explanation:
{ "constraints": ["constraint 1", "constraint 2", "constraint 3", "constraint 4"] }`;

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Call the LLM to suggest constraints based on the goal.
 * Returns an array of constraint strings, or [] on any failure.
 */
async function suggestConstraints(
    goal: GoalMemory,
    apiKey: string,
    model: string
): Promise<string[]> {
    const userPrompt = [
        `PROJECT GOAL: ${goal.goal}`,
        `CURRENT MILESTONE: ${goal.milestone}`,
        `SUCCESS METRIC: ${goal.success_metric}`,
        `TIME HORIZON: ${goal.time_horizon}`,
        goal.context ? `CONTEXT: ${goal.context}` : '',
    ].filter(Boolean).join('\n');

    try {
        const responseText = await callOpenRouter(
            apiKey,
            model,
            CONSTRAINT_SYSTEM_PROMPT,
            userPrompt,
            300  // Constraint list is short — 300 tokens max
        );

        const content = extractContent(responseText);
        if (!content) { return []; }

        // Strip markdown code fences if the LLM wrapped the JSON (common mistake)
        const cleaned = content
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        const parsed = JSON.parse(cleaned);

        // Accept both { constraints: [...] } and raw [...]
        const arr = Array.isArray(parsed) ? parsed : parsed.constraints;
        if (!Array.isArray(arr)) { return []; }

        // Filter to only valid strings, enforce min and max length, cap at 6.
        // The max-length guard prevents a misbehaving LLM from saving a 50KB
        // "constraint" that bloats every subsequent Detector prompt.
        return arr
            .filter((c: unknown): c is string =>
                typeof c === 'string' && c.length > 10 && c.length <= 500
            )
            .map((c: string) => c.replace(/[\x00-\x1f\x7f]/g, ' ').trim())
            .slice(0, 6);
    } catch (err: any) {
        logError(`Constraint suggestion failed: ${err.message}`);
        return [];
    }
}

/**
 * Show a VS Code quick-pick with suggested constraints.
 * All items are pre-selected (opt-out model — higher acceptance rate).
 * Returns the accepted constraint strings.
 */
async function promptConstraintPicker(
    suggestions: string[]
): Promise<string[]> {
    if (suggestions.length === 0) { return []; }

    const items = suggestions.map(s => ({
        label: s,
        picked: true,  // All pre-selected — opt-out model
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: '🧠 Socratic: Suggested constraints for your milestone',
        placeHolder: 'Uncheck any that don\'t apply. These help Socratic catch violations.',
    });

    return (picked ?? []).map(item => item.label);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Full constraint inference flow. Called from goal.ts after saveGoal().
 *
 * Flow: LLM suggestion → quick-pick → write to constraints.json
 * Any failure at any step → silent exit. Goal setup must never fail
 * because of this optional step.
 */
export async function setupConstraintsFromGoal(
    goal: GoalMemory,
    apiKey: string,
    model: string
): Promise<void> {
    // Show status bar spinner while generating
    const statusMessage = vscode.window.setStatusBarMessage(
        '$(sync~spin) Socratic: Analysing goal for constraints...',
        8000
    );

    try {
        const suggestions = await suggestConstraints(goal, apiKey, model);
        statusMessage.dispose(); // Clear the spinner

        if (suggestions.length === 0) { return; } // Silent fail — don't block goal setup

        const accepted = await promptConstraintPicker(suggestions);
        if (accepted.length === 0) { return; }

        // Write accepted constraints to memory
        for (const c of accepted) {
            addConstraint(c);
        }

        vscode.window.showInformationMessage(
            `✅ Socratic: ${accepted.length} constraint${accepted.length > 1 ? 's' : ''} added.`
        );
    } catch (err: any) {
        statusMessage.dispose();
        logError(`Constraint setup failed: ${err.message}`);
        // Silently continue — goal is already saved
    }
}

/**
 * Socratic AI — GitHub Action Headless Runner
 *
 * Runs the full Detector pipeline without VS Code — pure Node.js.
 * Reads .socratic/goal.json + constraints.json from the repo,
 * gets the PR diff from the environment, runs the LLM pipeline,
 * and outputs structured findings as JSON to stdout.
 *
 * This is the file that makes Socratic run on every PR
 * without anyone installing a VS Code extension.
 *
 * Environment variables:
 *   SOCRATIC_API_KEY   — OpenRouter API key (set as GitHub secret)
 *   SOCRATIC_MODEL     — model string (default: anthropic/claude-sonnet-4)
 *   GITHUB_WORKSPACE   — repo root (set automatically by GitHub Actions)
 *   PR_DIFF            — the raw git diff for the PR (set by action entrypoint)
 *   PR_TITLE           — PR title (for context)
 *   PR_BODY            — PR description (for context)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GoalMemory {
    goal: string;
    milestone: string;
    success_metric: string;
    time_horizon: string;
    context?: string;
}

interface ConstraintMemory {
    constraints: string[];
}

interface DecisionRecord {
    decision: string;
    rationale: string;
    timestamp: string;
}

interface ActionFinding {
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: 'security' | 'architecture' | 'constraint_violation' | 'scope_creep' | 'code_quality';
    issue: string;
    recommendation: string;
    evidence?: string;
}

interface ActionResult {
    verdict: 'concern' | 'lgtm';
    findings: ActionFinding[];
    summary: string;
    milestone_alignment: string;
}

// ─── Socratic Memory Reader ───────────────────────────────────────────────────

function readSocraticMemory(repoRoot: string): {
    goal: GoalMemory | null;
    constraints: string[];
    decisions: DecisionRecord[];
} {
    const socraticDir = path.join(repoRoot, '.socratic');

    let goal: GoalMemory | null = null;
    try {
        const raw = fs.readFileSync(path.join(socraticDir, 'goal.json'), 'utf-8');
        goal = JSON.parse(raw) as GoalMemory;
    } catch { /* no goal set — will warn */ }

    let constraints: string[] = [];
    try {
        const raw = fs.readFileSync(path.join(socraticDir, 'constraints.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        constraints = Array.isArray(parsed) ? parsed : (parsed.constraints || []);
    } catch { /* no constraints */ }

    let decisions: DecisionRecord[] = [];
    try {
        const raw = fs.readFileSync(path.join(socraticDir, 'decisions.json'), 'utf-8');
        const mem = JSON.parse(raw) as { decisions: DecisionRecord[] };
        decisions = (mem.decisions || []).slice(-5); // Last 5 decisions
    } catch { /* no decisions */ }

    return { goal, constraints, decisions };
}

// ─── LLM Client ───────────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 2_000_000;

function callOpenRouter(
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
        }, 30_000);

        const req = https.request({
            hostname: 'openrouter.ai',
            port: 443,
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/shivam952/Socatic-AI',
                'X-Title': 'Socratic AI GitHub Action',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            let responseBytes = 0;
            let tooLarge = false;

            res.on('data', (chunk: Buffer) => {
                responseBytes += chunk.length;
                if (responseBytes > MAX_RESPONSE_BYTES) {
                    tooLarge = true;
                    req.destroy();
                    clearTimeout(timeout);
                    reject(new Error('OpenRouter response exceeded size limit'));
                    return;
                }
                data += chunk;
            });

            res.on('end', () => {
                if (tooLarge) { return; }
                clearTimeout(timeout);
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`OpenRouter HTTP ${res.statusCode}`));
                }
            });
        });

        req.on('error', (err) => { clearTimeout(timeout); reject(err); });
        req.write(body);
        req.end();
    });
}

function extractContent(responseText: string): string | null {
    try {
        const data = JSON.parse(responseText);
        const raw: string | undefined = data.choices?.[0]?.message?.content;
        if (!raw) { return null; }
        return raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    } catch { return null; }
}

// ─── Review Prompt ────────────────────────────────────────────────────────────

const ACTION_SYSTEM_PROMPT = `You are a senior engineer reviewing a pull request.
You are NOT reviewing code in a vacuum. You have the developer's actual goal,
their stated constraints, and their recent decisions. Your job is to find
where this PR diverges from what they said they were building.

Review scope — look for:
1. CONSTRAINT VIOLATIONS: Does any code in this diff violate the stated constraints?
   This is the most important check. If a constraint says "no Redis before X" and this
   PR adds Redis, that's a direct violation. Name it exactly.
2. SCOPE CREEP: Does this PR add infrastructure, services, or abstractions that are
   premature given the current milestone? "We're validating retrieval quality" + "this PR
   adds Celery" = scope creep.
3. GOAL MISALIGNMENT: Does this PR move toward or away from the stated success metric?
4. SECURITY & QUALITY: Critical security issues or bugs only — not code style.

Rules:
- Be specific: quote the actual constraint being violated. Quote the actual code.
- Only flag REAL issues. If the PR is clean and aligned, say so.
- "lgtm" verdict = no blocking issues (still show medium/low if present).
- "concern" verdict = at least one critical or high issue, or constraint violation.
- Maximum 8 findings.

Respond ONLY with valid JSON:
{
  "verdict": "concern|lgtm",
  "summary": "one sentence overall assessment",
  "milestone_alignment": "one sentence on whether this PR moves toward the milestone",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|architecture|constraint_violation|scope_creep|code_quality",
      "issue": "what is wrong — reference the actual code or constraint",
      "recommendation": "what to change or discuss before merging",
      "evidence": "optional: short quote from the diff"
    }
  ]
}`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const apiKey = process.env.SOCRATIC_API_KEY || '';
    const model = process.env.SOCRATIC_MODEL || 'anthropic/claude-sonnet-4';
    const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const diff = process.env.PR_DIFF || '';
    const prTitle = process.env.PR_TITLE || '';
    const prBody = process.env.PR_BODY || '';

    if (!apiKey) {
        console.error('SOCRATIC_API_KEY not set. Add it as a GitHub secret.');
        process.exit(1);
    }

    // Read project memory
    const { goal, constraints, decisions } = readSocraticMemory(repoRoot);

    if (!goal) {
        // No goal.json in this repo — output a helpful message and exit cleanly
        const noGoalResult: ActionResult = {
            verdict: 'lgtm',
            findings: [],
            summary: 'No Socratic goal set for this project. Add .socratic/goal.json to enable goal-aware PR reviews.',
            milestone_alignment: 'N/A — no goal configured.',
        };
        console.log(JSON.stringify(noGoalResult, null, 2));
        process.exit(0);
    }

    if (!diff) {
        console.error('PR_DIFF is empty — nothing to review.');
        process.exit(0);
    }

    // Build prompt
    const contextParts = [
        `PROJECT GOAL: ${goal.goal}`,
        `CURRENT MILESTONE: ${goal.milestone}`,
        `SUCCESS METRIC: ${goal.success_metric}`,
        `TIME HORIZON: ${goal.time_horizon}`,
    ];

    if (goal.context) {
        contextParts.push(`TECH CONTEXT: ${goal.context}`);
    }

    if (constraints.length > 0) {
        contextParts.push(
            `\nCONSTRAINTS (must not be violated):\n` +
            constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
        );
    }

    if (decisions.length > 0) {
        contextParts.push(
            `\nRECENT DECISIONS:\n` +
            decisions.map(d => `  - ${d.decision} (${d.rationale})`).join('\n')
        );
    }

    if (prTitle) {
        contextParts.push(`\nPR TITLE: ${prTitle}`);
    }
    if (prBody) {
        contextParts.push(`PR DESCRIPTION: ${prBody.slice(0, 500)}`);
    }

    // Cap diff to stay within token budget
    const diffSnippet = diff.length > 8000
        ? diff.slice(0, 8000) + '\n...(diff truncated)'
        : diff;

    contextParts.push(`\nPULL REQUEST DIFF:\n${diffSnippet}`);

    const userPrompt = contextParts.join('\n') +
        '\n\nReview this PR against the goal and constraints above.';

    // Call LLM
    let result: ActionResult;
    try {
        const responseText = await callOpenRouter(
            apiKey, model, ACTION_SYSTEM_PROMPT, userPrompt, 1200
        );
        const content = extractContent(responseText);
        if (!content) { throw new Error('Empty response from LLM'); }

        const parsed = JSON.parse(content);

        // Sanitize
        const capStr = (v: unknown, max = 400): string =>
            String(v || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
        const capArr = (v: unknown): ActionFinding[] => {
            if (!Array.isArray(v)) { return []; }
            const VALID_SEV = new Set(['critical', 'high', 'medium', 'low']);
            const VALID_CAT = new Set(['security', 'architecture', 'constraint_violation', 'scope_creep', 'code_quality']);
            return v
                .filter((f: any) => typeof f.issue === 'string' && f.issue.length > 0)
                .map((f: any): ActionFinding => ({
                    severity: VALID_SEV.has(f.severity) ? f.severity : 'medium',
                    category: VALID_CAT.has(f.category) ? f.category : 'code_quality',
                    issue: capStr(f.issue),
                    recommendation: capStr(f.recommendation),
                    evidence: f.evidence ? capStr(f.evidence, 200) : undefined,
                }))
                .slice(0, 8);
        };

        result = {
            verdict: parsed.verdict === 'concern' ? 'concern' : 'lgtm',
            findings: capArr(parsed.findings),
            summary: capStr(parsed.summary),
            milestone_alignment: capStr(parsed.milestone_alignment),
        };
    } catch (err: any) {
        console.error(`Socratic LLM call failed: ${err.message}`);
        process.exit(1);
    }

    // Output JSON for the action entrypoint to consume
    console.log(JSON.stringify(result, null, 2));

    // Exit code: 1 if "concern" so the CI step can be set to fail optionally
    process.exit(result.verdict === 'concern' ? 1 : 0);
}

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});

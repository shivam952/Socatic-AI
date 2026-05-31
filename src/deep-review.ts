/**
 * Socratic AI — Deep Review Engine (Track 2.0)
 *
 * "AI that reviews your entire project, not just what changed."
 *
 * This is the proactive counterpart to the event-driven pipeline:
 *
 *   Event pipeline (V1):  something changed → is this one decision premature?
 *   Deep Review (V2):     natural checkpoint → what issues exist across the whole project?
 *
 * Three trigger moments:
 *   ONBOARDING  — right after goal + milestone are set for the first time.
 *                 Baseline: "here is what's already wrong before you write anything new."
 *   MILESTONE   — when the user updates their milestone (marks a natural review point).
 *                 Retrospective: "what accumulated debt, risks, and violations exist?"
 *   MANUAL      — user runs "Socratic: Deep Review" command explicitly.
 *
 * Architecture:
 *   1. Select files — recently modified source files, entry points, config files
 *   2. Build context snapshot — goal, constraints, decisions, file contents
 *   3. LLM deep review pass — structured multi-finding output
 *   4. Triage — sort by severity, deduplicate
 *   5. Report — formatted output channel report + summary notification
 *   6. Persist — save findings to .socratic/last-review.json for continuity
 *
 * Token budget strategy:
 *   - 12 files × 1500 chars = 18K chars ≈ 4500 tokens for file content
 *   - 2000 tokens for goal/constraints/decisions context
 *   - 1500 tokens for output
 *   Total ≈ 8000 tokens — well within most model limits
 *
 * Never throws — all failures are caught and logged. The extension must
 * never crash or show an error popup about its own internal failures.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { GoalMemory, getGoal } from './goal';
import { loadMemory } from './memory';
import { callOpenRouter, extractContent } from './openrouter';
import { logError } from './notifications';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewCategory = 'security' | 'architecture' | 'code_quality' | 'performance' | 'correctness';
export type ReviewMode = 'onboarding' | 'milestone' | 'manual';

export interface DeepFinding {
    severity: ReviewSeverity;
    category: ReviewCategory;
    file: string;          // Relative path, e.g. "src/memory.ts"
    issue: string;         // One clear sentence: what is wrong
    recommendation: string; // One clear sentence: what to do right now
    evidence?: string;     // Optional: a short quote or pattern from the code
}

export interface DeepReviewResult {
    timestamp: string;
    mode: ReviewMode;
    goal_snapshot: string;   // Goal at time of review (for future comparison)
    milestone_snapshot: string;
    findings: DeepFinding[];
    files_reviewed: number;
    summary: string;         // One-line LLM-generated summary
}

// ─── File Selection ───────────────────────────────────────────────────────────

const MAX_FILES = 12;
const MAX_CHARS_PER_FILE = 1500;

/**
 * Source file extensions worth reviewing (excluding pure markup/data).
 */
const REVIEWABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb',
    '.php', '.cs', '.cpp', '.c',
]);

/**
 * Config files that are always included regardless of recency.
 */
const ALWAYS_INCLUDE_NAMES = new Set([
    'package.json', 'pyproject.toml', 'requirements.txt',
    'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
    '.env.example', 'Makefile',
]);

/**
 * Paths and patterns that are never useful to review.
 */
const SKIP_PATTERNS = [
    /node_modules/, /__pycache__/, /\.git/, /\.socratic/,
    /out\//, /dist\//, /build\//, /\.venv/, /venv\//,
    /\.test\.(ts|js|py)$/, /\.spec\.(ts|js|py)$/, /test_.*\.py$/,
    /\.min\.js$/, /\.map$/,
];

function shouldSkip(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return SKIP_PATTERNS.some(p => p.test(normalized));
}

async function fileExistsAsync(p: string): Promise<boolean> {
    try {
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Select the most valuable files to review:
 *   1. Entry points (index.ts, main.py, app.py, etc.)
 *   2. Recently modified source files (from git log, or fallback to disk mtime)
 *   3. Always-include config files that exist
 *   4. Fill remaining slots with other source files
 *
 * Returns absolute paths.
 */
async function selectFilesForReview(root: string): Promise<string[]> {
    const selected: string[] = [];
    const seen = new Set<string>();

    function add(absPath: string): void {
        if (!seen.has(absPath) && !shouldSkip(absPath)) {
            seen.add(absPath);
            selected.push(absPath);
        }
    }

    // ── 1. Entry points ───────────────────────────────────────────────────────
    const entryPoints = [
        'src/index.ts', 'src/main.ts', 'src/extension.ts',
        'index.ts', 'index.js', 'main.py', 'app.py', 'server.py',
    ];
    for (const ep of entryPoints) {
        const full = path.join(root, ep);
        if (await fileExistsAsync(full)) { add(full); }
        if (selected.length >= 3) { break; }
    }

    // ── 2. Recently modified files from git ───────────────────────────────────
    try {
        const gitOut = await new Promise<string>((resolve) => {
            cp.exec(
                'git log --name-only --pretty=format: -20',
                { cwd: root, timeout: 4000 },
                (err, stdout) => resolve(err ? '' : stdout)
            );
        });

        const gitFiles = gitOut
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0)
            .map(l => path.join(root, l));

        for (const f of gitFiles) {
            if (selected.length >= MAX_FILES - 3) { break; } // Reserve slots for config
            if (!(await fileExistsAsync(f))) { continue; }
            const ext = path.extname(f);
            if (!REVIEWABLE_EXTENSIONS.has(ext)) { continue; }
            add(f);
        }
    } catch { /* git unavailable — continue */ }

    // ── 3. Always-include config files ────────────────────────────────────────
    for (const name of ALWAYS_INCLUDE_NAMES) {
        const full = path.join(root, name);
        if (await fileExistsAsync(full)) { add(full); }
    }

    // ── 4. Fill remaining slots by walking src/ ───────────────────────────────
    if (selected.length < MAX_FILES) {
        const srcDir = path.join(root, 'src');
        const walkDir = (await fileExistsAsync(srcDir)) ? srcDir : root;
        try {
            const entries = await fs.promises.readdir(walkDir);
            for (const name of entries) {
                if (selected.length >= MAX_FILES) { break; }
                const full = path.join(walkDir, name);
                const ext = path.extname(name);
                if (!REVIEWABLE_EXTENSIONS.has(ext)) { continue; }
                add(full);
            }
        } catch { /* skip */ }
    }

    return selected.slice(0, MAX_FILES);
}

/**
 * Read a file and return its contents, truncated to MAX_CHARS_PER_FILE.
 * Returns null if the file can't be read.
 */
async function readFileForReview(absPath: string): Promise<string | null> {
    try {
        const raw = await fs.promises.readFile(absPath, 'utf-8');
        if (raw.length <= MAX_CHARS_PER_FILE) { return raw; }
        return raw.slice(0, MAX_CHARS_PER_FILE) + '\n...(truncated)';
    } catch {
        return null;
    }
}

// ─── LLM Deep Review ─────────────────────────────────────────────────────────

const DEEP_REVIEW_SYSTEM_PROMPT = `You are a senior engineer doing a thorough pre-milestone code review.
Your job is to find every real issue in this codebase that could hurt the developer's milestone.

Review scope — look for ALL of the following:
- SECURITY: race conditions, unbounded buffers, synchronous I/O blocking an event loop,
  credentials or secrets in error messages or logs, missing input validation, path traversal,
  shell injection, unhandled large inputs, API keys in plaintext
- ARCHITECTURE: violations of the stated constraints, decisions that contradict the goal,
  premature abstraction, wrong coupling, missing error boundaries, single points of failure
- CODE QUALITY: platform-specific code that breaks on other OSes (e.g. path separators),
  missing null/undefined checks, non-atomic file operations, unbounded data structures
  (lists/files that grow without pruning), missing timeouts, swallowed errors
- CORRECTNESS: off-by-one logic, async/await mistakes, race conditions between concurrent
  operations, state that doesn't survive restarts

Rules:
- Be specific: name the exact variable, function, or pattern. Do NOT say "this file has issues."
- Every finding must reference the file it's in.
- Severity guide:
  critical = could crash the app, corrupt data, or expose secrets RIGHT NOW
  high     = will definitely cause a bug or security issue in real use
  medium   = will cause problems under load or edge cases
  low      = code smell, minor quality issue, non-blocking
- Only report REAL issues — not hypothetical concerns or style preferences.
- If you see nothing wrong in a file, do NOT invent findings for it.
- Maximum 12 findings total. Pick the most important ones.

Respond ONLY with valid JSON. No markdown. No explanation outside the JSON.
Schema:
{
  "summary": "string — one sentence summary of the overall codebase health",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|architecture|code_quality|performance|correctness",
      "file": "string — relative file path",
      "issue": "string — one clear sentence: what is wrong and where exactly",
      "recommendation": "string — one clear sentence: what to do RIGHT NOW",
      "evidence": "string — optional short quote or pattern from the actual code"
    }
  ]
}`;

async function runDeepReviewLLM(
    files: Array<{ path: string; relativePath: string; content: string }>,
    goal: GoalMemory,
    apiKey: string,
    model: string,
): Promise<{ summary: string; findings: DeepFinding[] } | null> {
    const memory = loadMemory(goal);

    // Build the context block
    const contextParts: string[] = [
        `PROJECT GOAL: ${goal.goal}`,
        `CURRENT MILESTONE: ${goal.milestone}`,
        `SUCCESS METRIC: ${goal.success_metric}`,
        `TIME HORIZON: ${goal.time_horizon}`,
    ];

    if (goal.context) {
        contextParts.push(`TECH CONTEXT: ${goal.context}`);
    }

    if (memory.constraints.constraints.length > 0) {
        contextParts.push(
            `CONSTRAINTS:\n${memory.constraints.constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`
        );
    }

    if (memory.decisions.decisions.length > 0) {
        const recent = memory.decisions.decisions.slice(-5);
        contextParts.push(
            `RECENT DECISIONS:\n${recent.map(d => `  - ${d.decision} (${d.rationale})`).join('\n')}`
        );
    }

    // Build the files block
    const filesPart = files.map(f =>
        `FILE: ${f.relativePath}\n${'─'.repeat(40)}\n${f.content}\n${'─'.repeat(40)}`
    ).join('\n\n');

    const userPrompt = [
        contextParts.join('\n'),
        '',
        'FILES TO REVIEW:',
        filesPart,
        '',
        'Review all files above. Find every real security risk, architecture violation, ' +
        'code quality issue, and correctness bug. Be specific — reference exact variable names, ' +
        'function names, and line patterns. Return structured JSON findings.',
    ].join('\n');

    try {
        const responseText = await callOpenRouter(
            apiKey,
            model,
            DEEP_REVIEW_SYSTEM_PROMPT,
            userPrompt,
            1500  // Enough for 12 detailed findings
        );

        const content = extractContent(responseText);
        if (!content) { return null; }

        const cleaned = content
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        const parsed = JSON.parse(cleaned);

        if (!Array.isArray(parsed.findings)) { return null; }

        // Validate and normalise each finding
        const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
        const VALID_CATEGORIES = new Set(['security', 'architecture', 'code_quality', 'performance', 'correctness']);

        const findings: DeepFinding[] = parsed.findings
            .filter((f: any) =>
                typeof f.file === 'string' &&
                typeof f.issue === 'string' &&
                typeof f.recommendation === 'string' &&
                f.file.length > 0 && f.issue.length > 0
            )
            .map((f: any): DeepFinding => ({
                severity: VALID_SEVERITIES.has(f.severity) ? f.severity : 'medium',
                category: VALID_CATEGORIES.has(f.category) ? f.category : 'code_quality',
                file: String(f.file).slice(0, 200),
                issue: String(f.issue).slice(0, 400),
                recommendation: String(f.recommendation).slice(0, 400),
                evidence: f.evidence ? String(f.evidence).slice(0, 200) : undefined,
            }))
            .slice(0, 12); // Hard cap

        return {
            summary: typeof parsed.summary === 'string'
                ? parsed.summary.slice(0, 300)
                : `${findings.length} finding(s) across ${files.length} files.`,
            findings,
        };
    } catch (err: any) {
        logError(`Deep review LLM call failed: ${err.message}`);
        return null;
    }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function getLastReviewPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return undefined; }
    return path.join(folders[0].uri.fsPath, '.socratic', 'last-review.json');
}

async function saveDeepReview(result: DeepReviewResult): Promise<void> {
    const reviewPath = getLastReviewPath();
    if (!reviewPath) { return; }
    try {
        const dir = path.dirname(reviewPath);
        if (!(await fileExistsAsync(dir))) { await fs.promises.mkdir(dir, { recursive: true }); }
        await fs.promises.writeFile(reviewPath, JSON.stringify(result, null, 2), 'utf-8');
    } catch (err: any) {
        logError(`Could not save deep review: ${err.message}`);
    }
}

export async function loadLastDeepReview(): Promise<DeepReviewResult | undefined> {
    const reviewPath = getLastReviewPath();
    if (!reviewPath || !(await fileExistsAsync(reviewPath))) { return undefined; }
    try {
        const content = await fs.promises.readFile(reviewPath, 'utf-8');
        return JSON.parse(content) as DeepReviewResult;
    } catch {
        return undefined;
    }
}

// ─── Report Formatting ────────────────────────────────────────────────────────

const SEVERITY_ICONS: Record<ReviewSeverity, string> = {
    critical: '🔴',
    high:     '🟠',
    medium:   '🟡',
    low:      '⚪',
};

const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Format a DeepReviewResult as a readable report for the output channel.
 */
export function formatDeepReviewReport(result: DeepReviewResult): string {
    const lines: string[] = [];
    const modeLabel = result.mode === 'onboarding' ? 'Onboarding Review'
        : result.mode === 'milestone' ? 'Milestone Review'
        : 'Manual Review';

    lines.push(`\n${'═'.repeat(64)}`);
    lines.push(`  🧠 SOCRATIC DEEP REVIEW — ${modeLabel.toUpperCase()}`);
    lines.push(`  ${new Date(result.timestamp).toLocaleString()}`);
    lines.push(`  Goal: "${result.goal_snapshot}"`);
    lines.push(`  Milestone: "${result.milestone_snapshot}"`);
    lines.push(`${'═'.repeat(64)}\n`);

    if (result.findings.length === 0) {
        lines.push(`  ✅ No significant issues found across ${result.files_reviewed} files reviewed.\n`);
        lines.push(`${'═'.repeat(64)}\n`);
        return lines.join('\n');
    }

    // Summary counts
    const counts = SEVERITY_ORDER.map(s => {
        const n = result.findings.filter(f => f.severity === s).length;
        return n > 0 ? `${SEVERITY_ICONS[s]} ${n} ${s}` : null;
    }).filter(Boolean).join('   ');

    lines.push(`  FILES REVIEWED: ${result.files_reviewed}   FINDINGS: ${result.findings.length}`);
    lines.push(`  ${counts}`);
    lines.push(`\n  SUMMARY: ${result.summary}\n`);
    lines.push('─'.repeat(64));

    // Findings grouped by severity
    for (const severity of SEVERITY_ORDER) {
        const group = result.findings.filter(f => f.severity === severity);
        if (group.length === 0) { continue; }

        lines.push(`\n${SEVERITY_ICONS[severity]} ${severity.toUpperCase()}\n`);

        for (const finding of group) {
            lines.push(`  ${finding.file}  [${finding.category}]`);
            lines.push(`  ⚠  ${finding.issue}`);
            lines.push(`  ✦  ${finding.recommendation}`);
            if (finding.evidence) {
                lines.push(`     Evidence: ${finding.evidence}`);
            }
            lines.push('');
        }
    }

    lines.push('─'.repeat(64));
    lines.push(`  Run "Socratic: Deep Review" again after fixing to verify progress.\n`);
    lines.push(`${'═'.repeat(64)}\n`);

    return lines.join('\n');
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run a full deep review of the project.
 *
 * Called automatically on:
 *   - First goal set (mode: 'onboarding')
 *   - Milestone update (mode: 'milestone')
 * Called manually via the socratic.deepReview command (mode: 'manual').
 *
 * Never throws. All failures are caught and logged.
 * Returns the review result, or undefined if the review could not run.
 */
export async function runDeepReview(
    mode: ReviewMode,
    apiKey: string,
    model: string
): Promise<DeepReviewResult | undefined> {
    const goal = getGoal();
    if (!goal) { return undefined; }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return undefined; }
    const root = folders[0].uri.fsPath;

    // Show spinner
    const spinnerMsg = vscode.window.setStatusBarMessage(
        `$(sync~spin) Socratic: Deep review in progress...`
    );

    try {
        // 1. Select files
        const filePaths = await selectFilesForReview(root);
        if (filePaths.length === 0) { return undefined; }

        // 2. Read files
        const files: Array<{ path: string; relativePath: string; content: string }> = [];
        for (const absPath of filePaths) {
            const content = await readFileForReview(absPath);
            if (content) {
                files.push({
                    path: absPath,
                    relativePath: path.relative(root, absPath).replace(/\\/g, '/'),
                    content,
                });
            }
        }

        if (files.length === 0) { return undefined; }

        // 3. LLM deep review
        const llmResult = await runDeepReviewLLM(files, goal, apiKey, model);
        if (!llmResult) { return undefined; }

        // 4. Build result
        const result: DeepReviewResult = {
            timestamp: new Date().toISOString(),
            mode,
            goal_snapshot: goal.goal,
            milestone_snapshot: goal.milestone,
            findings: llmResult.findings,
            files_reviewed: files.length,
            summary: llmResult.summary,
        };

        // 5. Persist — save before returning so history is always current.
        // Also archive to review-history for trajectory analysis.
        await saveDeepReview(result);
        await archiveDeepReview(result);

        return result;
    } catch (err: any) {
        logError(`Deep review failed: ${err.message}`);
        return undefined;
    } finally {
        spinnerMsg.dispose();
    }
}

// ─── Review History (for trajectory) ─────────────────────────────────────────

const MAX_HISTORY_ENTRIES = 20;

async function archiveDeepReview(result: DeepReviewResult): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const historyPath = path.join(folders[0].uri.fsPath, '.socratic', 'review-history.json');

    try {
        let history: DeepReviewResult[] = [];
        try {
            const raw = await fs.promises.readFile(historyPath, 'utf-8');
            history = JSON.parse(raw) as DeepReviewResult[];
        } catch { /* first entry */ }

        history.push(result);
        if (history.length > MAX_HISTORY_ENTRIES) {
            history = history.slice(-MAX_HISTORY_ENTRIES);
        }
        await fs.promises.writeFile(historyPath, JSON.stringify(history, null, 2));
    } catch (err: any) {
        logError(`Could not archive review: ${err.message}`);
    }
}

async function loadReviewHistory(): Promise<DeepReviewResult[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return []; }
    const historyPath = path.join(folders[0].uri.fsPath, '.socratic', 'review-history.json');
    try {
        const raw = await fs.promises.readFile(historyPath, 'utf-8');
        return JSON.parse(raw) as DeepReviewResult[];
    } catch { return []; }
}

// ─── Health Trajectory ────────────────────────────────────────────────────────

/**
 * Compare the last N deep reviews and produce a trajectory report.
 * Shows what's improving, what's regressing, and what's new.
 * No LLM call — pure diff over structured data.
 */
export async function buildTrajectoryReport(): Promise<string> {
    const history = await loadReviewHistory();
    if (history.length < 2) {
        return 'Not enough review history yet. Run deep reviews over multiple sessions to see your health trajectory.';
    }

    const recent = history.slice(-5); // Last 5 reviews
    const lines: string[] = [];

    lines.push(`\n${'═'.repeat(64)}`);
    lines.push(`  📈 SOCRATIC — HEALTH TRAJECTORY`);
    lines.push(`  ${recent.length} reviews analysed`);
    lines.push(`${'═'.repeat(64)}\n`);

    // Severity counts over time
    lines.push('  FINDING COUNTS OVER TIME:');
    lines.push('');

    for (const review of recent) {
        const date = new Date(review.timestamp).toLocaleDateString();
        const mode = review.mode.charAt(0).toUpperCase() + review.mode.slice(1);
        const critical = review.findings.filter(f => f.severity === 'critical').length;
        const high = review.findings.filter(f => f.severity === 'high').length;
        const medium = review.findings.filter(f => f.severity === 'medium').length;
        const total = review.findings.length;

        const bar = '█'.repeat(Math.min(total, 20));
        lines.push(`  ${date} (${mode})`);
        lines.push(`  ${bar} ${total} total  🔴${critical} 🟠${high} 🟡${medium}`);
        lines.push('');
    }

    // Resolved vs new issues between last two reviews
    const prev = recent[recent.length - 2];
    const curr = recent[recent.length - 1];

    const prevIssues = new Set(prev.findings.map(f => `${f.file}:${f.issue.slice(0, 60)}`));
    const currIssues = new Set(curr.findings.map(f => `${f.file}:${f.issue.slice(0, 60)}`));

    const resolved = prev.findings.filter(f => !currIssues.has(`${f.file}:${f.issue.slice(0, 60)}`));
    const newIssues = curr.findings.filter(f => !prevIssues.has(`${f.file}:${f.issue.slice(0, 60)}`));

    if (resolved.length > 0) {
        lines.push(`  ✅ RESOLVED since last review (${resolved.length}):`);
        for (const f of resolved) {
            lines.push(`     ${SEVERITY_ICONS[f.severity]} ${f.file} — ${f.issue.slice(0, 80)}`);
        }
        lines.push('');
    }

    if (newIssues.length > 0) {
        lines.push(`  🆕 NEW since last review (${newIssues.length}):`);
        for (const f of newIssues) {
            lines.push(`     ${SEVERITY_ICONS[f.severity]} ${f.file} — ${f.issue.slice(0, 80)}`);
        }
        lines.push('');
    }

    // Trend summary
    const prevCriticalHigh = prev.findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
    const currCriticalHigh = curr.findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
    const delta = currCriticalHigh - prevCriticalHigh;

    if (delta < 0) {
        lines.push(`  TREND: ↘ Improving — ${Math.abs(delta)} fewer critical/high issue(s) than last review.`);
    } else if (delta > 0) {
        lines.push(`  TREND: ↗ Regressing — ${delta} more critical/high issue(s) than last review.`);
    } else {
        lines.push(`  TREND: → Stable — same number of critical/high issues as last review.`);
    }

    lines.push('');
    lines.push(`${'═'.repeat(64)}\n`);
    return lines.join('\n');
}

// ─── Daily Focus ──────────────────────────────────────────────────────────────

/**
 * Compute a one-line daily focus message from local state.
 * Zero LLM calls — pure heuristics on goal.json + last-review.json.
 *
 * Returns a string like:
 *   "Socratic: 4 days left · 2 critical issues open · No eval script detected"
 */
export async function getDailyFocus(): Promise<string | null> {
    const goal = getGoal();
    if (!goal) { return null; }

    const parts: string[] = [];

    // Days remaining on milestone
    if (goal.time_horizon) {
        const horizon = goal.time_horizon.toLowerCase();
        const weeksMatch = horizon.match(/(\d+)\s*week/);
        const daysMatch = horizon.match(/(\d+)\s*day/);

        // Only show if we know the setAt time
        if (goal.setAt) {
            const setAt = new Date(goal.setAt).getTime();
            const now = Date.now();
            const elapsedDays = Math.floor((now - setAt) / (1000 * 60 * 60 * 24));

            let totalDays = 0;
            if (weeksMatch) { totalDays = parseInt(weeksMatch[1]) * 7; }
            else if (daysMatch) { totalDays = parseInt(daysMatch[1]); }

            if (totalDays > 0) {
                const remaining = totalDays - elapsedDays;
                if (remaining <= 0) {
                    parts.push(`⏰ Milestone overdue`);
                } else if (remaining <= 3) {
                    parts.push(`⚠ ${remaining}d left`);
                } else {
                    parts.push(`${remaining}d left`);
                }
            }
        }
    }

    // Open critical/high issues from last review
    const lastReview = await loadLastDeepReview();
    if (lastReview) {
        const critical = lastReview.findings.filter(f => f.severity === 'critical').length;
        const high = lastReview.findings.filter(f => f.severity === 'high').length;
        if (critical > 0) { parts.push(`🔴 ${critical} critical open`); }
        else if (high > 0) { parts.push(`🟠 ${high} high open`); }
    }

    // Heuristic: if success_metric mentions "eval" or "test" but no test/eval file exists
    const metric = (goal.success_metric || '').toLowerCase();
    if ((metric.includes('eval') || metric.includes('test') || metric.includes('hit rate') || metric.includes('%'))) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            const root = folders[0].uri.fsPath;
            try {
                const gitOut = await new Promise<string>((resolve) => {
                    cp.exec(
                        'git ls-files | grep -E "(eval|test|benchmark|score)" | head -3',
                        { cwd: root, timeout: 2000 },
                        (err, stdout) => resolve(err ? '' : stdout.trim())
                    );
                });
                if (!gitOut) {
                    parts.push(`📋 No eval script detected`);
                }
            } catch { /* skip */ }
        }
    }

    if (parts.length === 0) { return null; }
    return `Socratic: ${parts.join(' · ')}`;
}

/**
 * Socratic AI — Goal Inference from Repo (Track 1.5)
 *
 * Solves the biggest cold-start problem: requiring the developer to answer
 * 4 questions before getting their first warning. Most will never do it.
 *
 * Flow:
 *   1. Scan workspace — README, package files, git history, directory structure
 *   2. LLM infers goal + 3 sequential milestones from those signals
 *   3. Two quick-picks: confirm goal → pick current milestone
 *   4. saveGoal() + setupConstraintsFromGoal() — same as manual flow
 *
 * Fallbacks at every step — this must NEVER break the extension.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { GoalMemory, saveGoal } from './goal';
import { setupConstraintsFromGoal } from './constraints';
import { callOpenRouter, extractContent } from './openrouter';
import { logError } from './notifications';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceSignals {
    readme?: string;
    packageName?: string;
    packageDescription?: string;
    dependencies: string[];
    gitLog?: string;
    directoryStructure: string;
    entryPoint?: string;
    language: 'python' | 'typescript' | 'javascript' | 'mixed' | 'unknown';
}

interface MilestoneSuggestion {
    label: string;          // Short label for quick-pick display
    milestone: string;      // Full milestone description
    success_metric: string;
    time_horizon: string;
}

interface InferredGoal {
    goal: string;
    context: string;
    milestones: MilestoneSuggestion[];
}

// ─── LLM String Sanitizer ─────────────────────────────────────────────────────

const MAX_GOAL_FIELD_CHARS = 500;

/**
 * Sanitize a string coming from LLM output before persisting to disk.
 * Strips control characters, trims whitespace, enforces a max length.
 * This prevents a confused or adversarial LLM from writing multi-KB
 * strings into goal.json that would bloat every subsequent Detector prompt.
 */
function sanitizeLLMString(s: unknown, maxLen = MAX_GOAL_FIELD_CHARS): string {
    if (typeof s !== 'string') { return ''; }
    return s
        .replace(/[\x00-\x1f\x7f]/g, ' ')  // strip control characters
        .trim()
        .slice(0, maxLen);
}

// ─── Signal Gathering ─────────────────────────────────────────────────────────

/**
 * Collect project signals from disk. Graceful on every read —
 * missing files are skipped, not errors.
 * This function is async because git log is read with exec (non-blocking).
 */
export async function gatherWorkspaceSignals(root: string): Promise<WorkspaceSignals> {
    const signals: WorkspaceSignals = {
        dependencies: [],
        directoryStructure: '',
        language: 'unknown',
    };

    // ── README ────────────────────────────────────────────────────────────────
    for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
        const p = path.join(root, name);
        try {
            const content = await fs.promises.readFile(p, 'utf-8');
            signals.readme = content.slice(0, 2500);
            break;
        } catch { /* skip */ }
    }

    // ── package.json ──────────────────────────────────────────────────────────
    const pkgPath = path.join(root, 'package.json');
    try {
        const content = await fs.promises.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        signals.packageName = pkg.name;
        signals.packageDescription = pkg.description;
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
        signals.dependencies = deps.slice(0, 25);
        signals.language = 'typescript'; // or javascript — good enough for inference
    } catch { /* skip */ }

    // ── pyproject.toml / requirements.txt ────────────────────────────────────
    const pyprojectPath = path.join(root, 'pyproject.toml');
    const reqPath = path.join(root, 'requirements.txt');

    try {
        const content = await fs.promises.readFile(pyprojectPath, 'utf-8');
        const nameMatch = content.match(/^name\s*=\s*["'](.+?)["']/m);
        const descMatch = content.match(/^description\s*=\s*["'](.+?)["']/m);
        if (nameMatch) { signals.packageName = nameMatch[1]; }
        if (descMatch) { signals.packageDescription = descMatch[1]; }
        signals.language = 'python';
    } catch { /* skip */ }

    if (signals.dependencies.length === 0) {
        try {
            const content = await fs.promises.readFile(reqPath, 'utf-8');
            const deps = content
                .split('\n')
                .map(l => l.split(/[>=<!]/)[0].trim())
                .filter(l => l && !l.startsWith('#'))
                .slice(0, 25);
            signals.dependencies = deps;
            signals.language = 'python';
        } catch { /* skip */ }
    }

    // ── Git log ───────────────────────────────────────────────────────────────
    // Use async exec — cp.execSync blocks the extension host event loop for the
    // entire duration of the command, freezing VS Code UI input handling.
    try {
        signals.gitLog = await new Promise<string>((resolve) => {
            cp.exec('git log --oneline -15', { cwd: root, timeout: 3000 }, (err, stdout) => {
                resolve(err ? '' : stdout.trim());
            });
        }) || undefined;
    } catch { /* not a git repo or no commits */ }

    // ── Directory structure ───────────────────────────────────────────────────
    try {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.') &&
                !['node_modules', '__pycache__', '.venv', 'venv', 'dist', 'out', 'build'].includes(e.name))
            .map(e => `${e.name}/`);
        const files = entries
            .filter(e => e.isFile() && !e.name.startsWith('.'))
            .map(e => e.name)
            .slice(0, 15);
        signals.directoryStructure = [...dirs, ...files].join('  ');
    } catch { /* skip */ }

    // ── Entry point ───────────────────────────────────────────────────────────
    const entryPoints = ['main.py', 'app.py', 'index.ts', 'index.js', 'src/index.ts', 'src/main.ts'];
    for (const ep of entryPoints) {
        const epPath = path.join(root, ep);
        try {
            const content = await fs.promises.readFile(epPath, 'utf-8');
            signals.entryPoint = content.slice(0, 500);
            break;
        } catch { /* skip */ }
    }

    return signals;
}

// ─── LLM Inference ───────────────────────────────────────────────────────────

const INFERENCE_SYSTEM_PROMPT = `You are a senior engineer doing a project intake.
Given signals about a developer's codebase, infer their primary goal and suggest
three sequential milestones they are likely working through.

Rules:
- The goal must be concrete, not generic ("Build X that does Y" not "Build a good app")
- Milestones must be sequential — milestone 2 only makes sense after milestone 1 is done
- Each milestone needs a measurable success metric (something you can test)
- Time horizons: first milestone 1-2 weeks, second 1 month, third 2-3 months
- The FIRST milestone should reflect where a developer with this codebase likely IS now
- Tech context: extract the actual stack from the signals (specific frameworks, not "web app")

Respond ONLY with valid JSON. No markdown fences. No explanation.
Schema:
{
  "goal": "string — primary objective in one sentence",
  "context": "string — detected tech stack and constraints",
  "milestones": [
    {
      "label": "string — 5-word max for display",
      "milestone": "string — full milestone description",
      "success_metric": "string — specific measurable outcome",
      "time_horizon": "string — e.g. '2 weeks'"
    }
  ]
}`;

async function inferGoalFromSignals(
    signals: WorkspaceSignals,
    apiKey: string,
    model: string
): Promise<InferredGoal | null> {
    const parts: string[] = [];

    if (signals.readme) {
        parts.push(`README:\n${signals.readme}`);
    }
    if (signals.packageName || signals.packageDescription) {
        parts.push(`Project: ${signals.packageName ?? ''} — ${signals.packageDescription ?? ''}`);
    }
    if (signals.dependencies.length > 0) {
        parts.push(`Dependencies: ${signals.dependencies.join(', ')}`);
    }
    if (signals.gitLog) {
        parts.push(`Recent commits:\n${signals.gitLog}`);
    }
    if (signals.directoryStructure) {
        parts.push(`Directory: ${signals.directoryStructure}`);
    }
    if (signals.entryPoint) {
        parts.push(`Entry point (first 500 chars):\n${signals.entryPoint}`);
    }

    if (parts.length === 0) { return null; }

    const userPrompt = parts.join('\n\n') +
        '\n\nBased on these signals, infer the goal and three sequential milestones.';

    try {
        const response = await callOpenRouter(apiKey, model, INFERENCE_SYSTEM_PROMPT, userPrompt, 600);
        const content = extractContent(response);
        if (!content) { return null; }

        const cleaned = content
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        const raw = JSON.parse(cleaned) as InferredGoal;

        if (
            typeof raw.goal !== 'string' ||
            !Array.isArray(raw.milestones) ||
            raw.milestones.length === 0
        ) { return null; }

        // Sanitize all LLM-generated strings before returning — prevents a
        // misbehaving or adversarial LLM from writing huge strings to goal.json.
        const parsed: InferredGoal = {
            goal: sanitizeLLMString(raw.goal),
            context: sanitizeLLMString(raw.context ?? ''),
            milestones: raw.milestones.slice(0, 5).map(m => ({
                label: sanitizeLLMString(m.label, 60),
                milestone: sanitizeLLMString(m.milestone),
                success_metric: sanitizeLLMString(m.success_metric),
                time_horizon: sanitizeLLMString(m.time_horizon, 50),
            })),
        };

        if (!parsed.goal || parsed.milestones.length === 0) { return null; }

        return parsed;
    } catch (err: any) {
        logError(`Goal inference failed: ${err.message}`);
        return null;
    }
}

// ─── Confirmation UX ──────────────────────────────────────────────────────────

/**
 * Step 1: Show the inferred goal and ask for confirmation.
 * Returns 'accepted' | 'edit' | 'manual' | 'skip'
 */
async function confirmGoal(
    inferred: InferredGoal
): Promise<'accepted' | 'edit' | 'manual' | 'skip'> {
    const items = [
        {
            label: '$(check) Looks right',
            description: inferred.goal,
            detail: `Tech context: ${inferred.context}`,
            value: 'accepted' as const,
        },
        {
            label: '$(edit) Edit this goal',
            description: 'Tweak the inferred goal before saving',
            value: 'edit' as const,
        },
        {
            label: '$(list-ordered) Set goal manually',
            description: 'Answer the 4-question setup instead',
            value: 'manual' as const,
        },
        {
            label: '$(close) Skip for now',
            description: 'Set a goal later via "Socratic: Set Project Goal"',
            value: 'skip' as const,
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: '🧠 Socratic: I analysed your project',
        placeHolder: 'Does this look right?',
        ignoreFocusOut: true,
    });

    return picked?.value ?? 'skip';
}

/**
 * Step 2: Pick a milestone from the three suggestions.
 * Returns the selected MilestoneSuggestion, a custom one, or null.
 */
async function pickMilestone(
    milestones: MilestoneSuggestion[]
): Promise<MilestoneSuggestion | null> {
    const items = [
        ...milestones.map((m, i) => ({
            label: `$(milestone) ${m.label}`,
            description: m.milestone,
            detail: `✅ ${m.success_metric}  ·  ⏱ ${m.time_horizon}`,
            milestone: m,
            isCustom: false,
        })),
        {
            label: '$(pencil) Enter my own milestone',
            description: 'Type a custom milestone',
            detail: '',
            milestone: null as MilestoneSuggestion | null,
            isCustom: true,
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: '📍 What are you proving right now?',
        placeHolder: 'Pick your current milestone',
        ignoreFocusOut: true,
    });

    if (!picked) { return null; }

    if (picked.isCustom) {
        const custom = await vscode.window.showInputBox({
            prompt: '📍 What is your current milestone?',
            placeHolder: 'e.g., Prove retrieval quality before extending the agent graph',
            ignoreFocusOut: true,
        });
        if (!custom) { return null; }

        const metric = await vscode.window.showInputBox({
            prompt: '✅ How will you know this milestone is done?',
            placeHolder: 'e.g., >80% top-k hit rate on 50 test documents',
            ignoreFocusOut: true,
        });

        return {
            label: 'Custom',
            milestone: custom,
            success_metric: metric ?? 'Done when I decide it is',
            time_horizon: '2 weeks',
        };
    }

    return picked.milestone;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Full goal inference flow. Called from extension.ts on activation
 * when no goal.json exists and an API key is configured.
 *
 * Returns the saved GoalMemory on success, undefined otherwise.
 * Never throws — all failures fall back gracefully.
 */
export async function runGoalInference(
    apiKey: string,
    model: string
): Promise<GoalMemory | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return undefined; }
    const root = workspaceFolders[0].uri.fsPath;

    // Gather signals
    const statusMsg = vscode.window.setStatusBarMessage(
        '$(sync~spin) Socratic: Reading your project...'
    );

    let inferred: InferredGoal | null = null;
    try {
        const signals = await gatherWorkspaceSignals(root);
        inferred = await inferGoalFromSignals(signals, apiKey, model);
    } catch (err: any) {
        logError(`Signal gathering failed: ${err.message}`);
    } finally {
        statusMsg.dispose();
    }

    if (!inferred) {
        // Inference failed — fall back to manual flow
        vscode.window.showInformationMessage(
            'Socratic: Could not infer project goal. Set it manually?',
            'Set Goal'
        ).then(action => {
            if (action === 'Set Goal') {
                vscode.commands.executeCommand('socratic.setGoal');
            }
        });
        return undefined;
    }

    // Step 1: Confirm goal
    const confirmation = await confirmGoal(inferred);

    if (confirmation === 'skip') { return undefined; }
    if (confirmation === 'manual') {
        vscode.commands.executeCommand('socratic.setGoal');
        return undefined;
    }

    let finalGoal = inferred.goal;
    let finalContext = inferred.context;

    if (confirmation === 'edit') {
        const edited = await vscode.window.showInputBox({
            prompt: '🎯 Edit your project goal',
            value: inferred.goal,
            ignoreFocusOut: true,
        });
        if (!edited) { return undefined; }
        finalGoal = edited;

        const editedContext = await vscode.window.showInputBox({
            prompt: '📋 Edit tech context (optional)',
            value: inferred.context,
            ignoreFocusOut: true,
        });
        if (editedContext !== undefined) { finalContext = editedContext; }
    }

    // Step 2: Pick milestone
    const milestone = await pickMilestone(inferred.milestones);
    if (!milestone) { return undefined; }

    // Save and run constraint inference
    const goalMemory: GoalMemory = {
        goal: finalGoal,
        milestone: milestone.milestone,
        success_metric: milestone.success_metric,
        time_horizon: milestone.time_horizon,
        setAt: new Date().toISOString(),
        context: finalContext || undefined,
    };

    saveGoal(goalMemory);
    vscode.window.showInformationMessage(
        `🎯 Socratic: Goal set — "${finalGoal.length > 60 ? finalGoal.slice(0, 60) + '...' : finalGoal}"`
    );

    // Run constraint inference — same as manual flow
    await setupConstraintsFromGoal(goalMemory, apiKey, model);

    return goalMemory;
}

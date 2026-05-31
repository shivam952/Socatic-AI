/**
 * Socratic AI — Goal Management (V1)
 *
 * Stores the user's project goal per-workspace in .socratic/goal.json.
 * V1 extends the goal schema to include milestone, success_metric, and time_horizon —
 * all required for the Detector to produce milestone-grounded warnings.
 *
 * 🏗️ ARCHITECTURE NOTE:
 * Goal quality = warning quality. A vague goal ("build stuff") produces generic,
 * useless questions. The multi-step prompt flow forces specificity.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { setupConstraintsFromGoal } from './constraints';

// V1 Goal schema — all fields required except context
export interface GoalMemory {
    goal: string;           // Primary objective
    milestone: string;      // Current immediate focus (what are you proving RIGHT NOW)
    success_metric: string; // How we know the milestone is done
    time_horizon: string;   // e.g., "2 weeks", "this sprint"
    setAt: string;
    context?: string;       // Optional: tech stack, team size, extra constraints
}

// ─── Internal path helpers ────────────────────────────────────────────────────

export function getSocraticDir(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return path.join(workspaceFolders[0].uri.fsPath, '.socratic');
}

function getGoalPath(): string | undefined {
    const dir = getSocraticDir();
    return dir ? path.join(dir, 'goal.json') : undefined;
}

export function ensureSocraticDir(): string | undefined {
    const dir = getSocraticDir();
    if (!dir) { return undefined; }
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

export function getGoal(): GoalMemory | undefined {
    const goalPath = getGoalPath();
    if (!goalPath || !fs.existsSync(goalPath)) {
        return undefined;
    }
    try {
        const raw = fs.readFileSync(goalPath, 'utf-8');
        return JSON.parse(raw) as GoalMemory;
    } catch {
        // 7.6: Silent failure here means the developer has no idea why Socratic
        // stopped working. Show a one-time actionable notification.
        vscode.window.showErrorMessage(
            'Socratic: goal.json appears corrupted. Run "Socratic: Set Project Goal" to fix.',
            'Set Goal'
        ).then(action => {
            if (action === 'Set Goal') {
                vscode.commands.executeCommand('socratic.setGoal');
            }
        });
        return undefined;
    }
}

export function saveGoal(goal: GoalMemory): void {
    const goalPath = getGoalPath();
    if (!goalPath) {
        vscode.window.showErrorMessage('Socratic: No workspace folder open.');
        return;
    }
    ensureSocraticDir();
    fs.writeFileSync(goalPath, JSON.stringify(goal, null, 2));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Multi-step prompt — sets the full V1 goal schema.
 * All fields are required except context.
 */
export async function promptSetGoal(): Promise<GoalMemory | undefined> {
    const goal = await vscode.window.showInputBox({
        prompt: '🎯 (1/4) What is your primary project goal?',
        placeHolder: 'e.g., Build a local-first RAG MVP and validate retrieval quality before scaling',
        ignoreFocusOut: true,
    });
    if (!goal) { return undefined; }

    const milestone = await vscode.window.showInputBox({
        prompt: '📍 (2/4) What is your CURRENT milestone? (What are you proving right now?)',
        placeHolder: 'e.g., Prove top-k hit rate on 50 test documents',
        ignoreFocusOut: true,
    });
    if (!milestone) { return undefined; }

    const success_metric = await vscode.window.showInputBox({
        prompt: '✅ (3/4) How will you know this milestone is done?',
        placeHolder: 'e.g., >80% top-k hit rate on the 50-doc eval set',
        ignoreFocusOut: true,
    });
    if (!success_metric) { return undefined; }

    const time_horizon = await vscode.window.showInputBox({
        prompt: '⏱️ (4/4) What is the time horizon for this milestone?',
        placeHolder: 'e.g., 2 weeks, this sprint, by Friday',
        ignoreFocusOut: true,
    });
    if (!time_horizon) { return undefined; }

    const context = await vscode.window.showInputBox({
        prompt: '📋 Any extra context? (optional — tech stack, constraints, team size)',
        placeHolder: 'e.g., Python, solo, no cloud infra, 10 source PDFs',
        ignoreFocusOut: true,
    });

    const goalMemory: GoalMemory = {
        goal,
        milestone,
        success_metric,
        time_horizon,
        setAt: new Date().toISOString(),
        context: context || undefined,
    };

    saveGoal(goalMemory);
    vscode.window.showInformationMessage(
        `🎯 Socratic: Goal set — "${goal}" | Milestone: "${milestone}"`
    );

    // Track 1.1: Auto-suggest constraints from goal — removes cold-start friction.
    // Reads API key from config. If not set yet, skip silently (user can add
    // constraints manually later or they'll be prompted on next goal set).
    const config = vscode.workspace.getConfiguration('socratic');
    const apiKey = config.get<string>('apiKey', '');
    const model = config.get<string>('model', 'anthropic/claude-sonnet-4');
    if (apiKey) {
        await setupConstraintsFromGoal(goalMemory, apiKey, model);
    }

    return goalMemory;
}

/**
 * Update only the milestone + success_metric fields.
 * Used when the goal stays the same but the user moves to the next milestone.
 */
export async function promptSetMilestone(): Promise<void> {
    const current = getGoal();
    if (!current) {
        vscode.window.showWarningMessage('Socratic: Set a goal first before updating milestone.');
        return;
    }

    const milestone = await vscode.window.showInputBox({
        prompt: '📍 What is your new milestone?',
        placeHolder: 'e.g., Ship auth flow end-to-end',
        ignoreFocusOut: true,
        value: current.milestone,
    });
    if (!milestone) { return; }

    const success_metric = await vscode.window.showInputBox({
        prompt: '✅ How will you know this milestone is done?',
        placeHolder: 'e.g., User can sign up, log in, and see dashboard',
        ignoreFocusOut: true,
        value: current.success_metric,
    });
    if (!success_metric) { return; }

    saveGoal({ ...current, milestone, success_metric });
    vscode.window.showInformationMessage(`📍 Socratic: Milestone updated — "${milestone}"`);
}

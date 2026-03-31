/**
 * Socratic AI — Extension Entry Point (V1)
 *
 * "AI that questions your thinking, not writes your code."
 *
 * V1 Flow:
 *   1. User sets a goal (goal + milestone + metric + horizon)
 *   2. User codes normally
 *   3. On high-signal save events → two-stage pipeline fires
 *   4. Detector proposes a candidate issue (or null)
 *   5. Verifier audits: concrete? evidenced? worth interrupting?
 *   6. Level 0 → silence | Level 1 → panel | Level 2 → notification
 *   7. User feedback captured → regret tracking
 */
import * as vscode from 'vscode';
import { promptSetGoal, promptSetMilestone, getGoal } from './goal';
import { initNotifications, initStatusBar } from './notifications';
import {
    addConstraint,
    addDecision,
    getWarningsSummary,
} from './memory';
import { initializeWorkspaceState } from './trigger';

export function activate(context: vscode.ExtensionContext) {
    console.log('Socratic AI activated');

    // Initialize UI components
    const outputChannel = initNotifications();
    const statusBar = initStatusBar();
    context.subscriptions.push(outputChannel, statusBar);

    // Initialize workspace state baseline (known files, known deps).
    // Must run before the watcher is registered so new files are detected correctly.
    initializeWorkspaceState(context.workspaceState);

    // ── Core Commands ─────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.setGoal', async () => {
            await promptSetGoal();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.showGoal', () => {
            const goal = getGoal();
            if (goal) {
                vscode.window.showInformationMessage(
                    `🎯 Goal: "${goal.goal}" | Milestone: "${goal.milestone}"`
                );
            } else {
                vscode.window.showInformationMessage(
                    'No goal set. Run "Socratic: Set Project Goal" to get started.'
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: '🔑 Enter your OpenRouter API key',
                placeHolder: 'sk-or-v1-...',
                password: true,
                ignoreFocusOut: true,
            });
            if (key) {
                await vscode.workspace.getConfiguration('socratic').update(
                    'apiKey',
                    key,
                    vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage('✅ Socratic: API key saved.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.analyzeNow', async () => {
            const goal = getGoal();
            if (!goal) {
                const setNow = await vscode.window.showWarningMessage(
                    'Socratic: No goal set. Set a goal first?',
                    'Set Goal', 'Cancel'
                );
                if (setNow === 'Set Goal') { await promptSetGoal(); }
                return;
            }
            // Wired to trigger.ts + pipeline.ts in Step 5
            vscode.window.showInformationMessage('Socratic: Manual analysis will be wired in Step 5.');
        })
    );

    // ── V1 New Commands ───────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.setMilestone', async () => {
            await promptSetMilestone();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.addConstraint', async () => {
            const goal = getGoal();
            if (!goal) {
                vscode.window.showWarningMessage('Socratic: Set a goal first.');
                return;
            }
            const constraint = await vscode.window.showInputBox({
                prompt: '🚧 Add a project constraint',
                placeHolder: 'e.g., No cloud infra until retrieval is validated',
                ignoreFocusOut: true,
            });
            if (constraint) {
                addConstraint(constraint);
                vscode.window.showInformationMessage(`✅ Constraint added — "${constraint}"`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.logDecision', async () => {
            if (!getGoal()) {
                vscode.window.showWarningMessage('Socratic: Set a goal first.');
                return;
            }
            const decision = await vscode.window.showInputBox({
                prompt: '📝 (1/3) What did you decide?',
                placeHolder: 'e.g., Using local FAISS instead of Pinecone',
                ignoreFocusOut: true,
            });
            if (!decision) { return; }

            const rationale = await vscode.window.showInputBox({
                prompt: '💡 (2/3) Why?',
                placeHolder: 'e.g., Too early for managed vector DB before eval is stable',
                ignoreFocusOut: true,
            });
            if (!rationale) { return; }

            const rejected = await vscode.window.showInputBox({
                prompt: '❌ (3/3) Rejected alternatives? (comma-separated, optional)',
                placeHolder: 'e.g., Pinecone, Weaviate',
                ignoreFocusOut: true,
            });

            addDecision({
                decision,
                rationale,
                rejected_alternatives: rejected ? rejected.split(',').map(s => s.trim()) : [],
                source: 'manual',
            });
            vscode.window.showInformationMessage(`📝 Decision logged — "${decision}"`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.showWarningsLog', () => {
            outputChannel.appendLine(getWarningsSummary());
            outputChannel.show(true);
        })
    );

    // ── Startup banner ────────────────────────────────────────────────────────

    const goal = getGoal();
    if (!goal) {
        outputChannel.appendLine('═══════════════════════════════════════');
        outputChannel.appendLine('  🧠 Socratic AI V1 — Ready');
        outputChannel.appendLine('  Step 1: Run "Socratic: Set Project Goal"');
        outputChannel.appendLine('  Step 2: Run "Socratic: Set API Key"');
        outputChannel.appendLine('═══════════════════════════════════════');
    } else {
        outputChannel.appendLine(`🎯 Socratic AI V1 active`);
        outputChannel.appendLine(`   Goal: "${goal.goal}"`);
        outputChannel.appendLine(`   Milestone: "${goal.milestone}"`);
    }
}

export function deactivate() {
    console.log('Socratic AI deactivated');
}

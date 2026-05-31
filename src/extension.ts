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
import * as path from 'path';
import { promptSetGoal, promptSetMilestone, getGoal } from './goal';
import { initNotifications, initStatusBar } from './notifications';
import {
    addConstraint,
    addDecision,
    getWarningsSummary,
} from './memory';
import { initializeWorkspaceState, parseDiffToTriggers } from './trigger';
import { registerWatcher, runAnalysis, triggerManualAnalysis, clearDebounceAndRunPending } from './watcher';
import { GitHookServer } from './git-hook-server';
import { installGitHook } from './git-hook-installer';
import { runGoalInference } from './goal-inference';
import { runDeepReview, formatDeepReviewReport, getDailyFocus, buildTrajectoryReport } from './deep-review';
import { runPreShipReview } from './pre-ship-review';

// 7.5: activate is async so we can await initializeWorkspaceState before
// registerWatcher. Without await, saves arriving during a slow findFiles scan
// on a large workspace would treat every existing file as "new".
export async function activate(context: vscode.ExtensionContext) {
    console.log('Socratic AI activated');

    // Initialize UI components
    const outputChannel = initNotifications();
    const statusBar = initStatusBar();
    context.subscriptions.push(outputChannel, statusBar);

    // 7.5: Must await — watcher must not start until the baseline is ready.
    await initializeWorkspaceState(context.workspaceState);

    // Register the file save watcher (accumulating debounce → trigger → pipeline)
    registerWatcher(context);

    // Track 1.3: Git hook server — listens for pre-commit payloads.
    // Commit triggers bypass the debounce — a commit IS a decision, analyze immediately.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const gitServer = new GitHookServer();
    if (workspaceRoot) {
        gitServer.start(
            workspaceRoot,
            async (stat, diff) => {
                const trigger = parseDiffToTriggers(stat, diff);
                if (trigger.type === 'none') { return; }
                await clearDebounceAndRunPending(trigger, context);
            },
            (msg) => outputChannel.appendLine(`[Socratic internal] ${msg}`)
        );
        context.subscriptions.push({ dispose: () => gitServer.stop() });

        // Track 2.1: Pre-Ship Review watchers
        const tagsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.git/refs/tags/**'));
        const mainWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.git/refs/heads/main'));
        const masterWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.git/refs/heads/master'));

        const triggerPreShip = async (source: string) => {
            const currentGoal = getGoal();
            const config = vscode.workspace.getConfiguration('socratic');
            const apiKey = config.get<string>('apiKey', '');
            const model = config.get<string>('model', 'anthropic/claude-sonnet-4');
            if (currentGoal && apiKey) {
                await runPreShipReview(source, apiKey, model, outputChannel);
            }
        };

        tagsWatcher.onDidCreate(() => triggerPreShip('Git Tag Created'));
        mainWatcher.onDidChange(() => triggerPreShip('Merged to main branch'));
        masterWatcher.onDidChange(() => triggerPreShip('Merged to master branch'));

        let lastKnownVersion = '';
        try {
            const pkgUri = vscode.Uri.file(path.join(workspaceRoot, 'package.json'));
            vscode.workspace.fs.readFile(pkgUri).then(content => {
                try {
                    lastKnownVersion = JSON.parse(Buffer.from(content).toString('utf-8')).version || '';
                } catch {}
            });
        } catch {}

        const pkgWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, 'package.json'));
        pkgWatcher.onDidChange(async (uri) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const pkg = JSON.parse(Buffer.from(content).toString('utf-8'));
                if (pkg.version && pkg.version !== lastKnownVersion && lastKnownVersion !== '') {
                    lastKnownVersion = pkg.version;
                    triggerPreShip('Version bump in package.json');
                } else if (pkg.version && lastKnownVersion === '') {
                    lastKnownVersion = pkg.version;
                }
            } catch {}
        });

        context.subscriptions.push(tagsWatcher, mainWatcher, masterWatcher, pkgWatcher);
    }

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
            await triggerManualAnalysis(context);
        })
    );

    // ── V1 New Commands ───────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.setMilestone', async () => {
            await promptSetMilestone();

            // Track 2.0: After a milestone update, run a deep review automatically.
            // A milestone change IS a natural checkpoint — it's the developer saying
            // "I finished one thing, starting the next." That is exactly the right
            // moment to surface accumulated debt, architecture drift, and risks
            // before they build the next layer on top of them.
            const currentGoal = getGoal();
            const config = vscode.workspace.getConfiguration('socratic');
            const apiKey = config.get<string>('apiKey', '');
            const model = config.get<string>('model', 'anthropic/claude-sonnet-4');
            if (currentGoal && apiKey) {
                const result = await runDeepReview('milestone', apiKey, model);
                if (result) {
                    outputChannel.appendLine(formatDeepReviewReport(result));
                    outputChannel.show(true);

                    const critical = result.findings.filter((f: { severity: string }) => f.severity === 'critical').length;
                    const high = result.findings.filter((f: { severity: string }) => f.severity === 'high').length;
                    const total = result.findings.length;

                    if (critical > 0) {
                        vscode.window.showWarningMessage(
                            `🔴 Socratic Milestone Review: ${critical} critical issue(s) to fix before you proceed.`,
                            'Show Report'
                        ).then(a => { if (a === 'Show Report') { outputChannel.show(true); } });
                    } else if (total > 0) {
                        vscode.window.showInformationMessage(
                            `🟡 Socratic Milestone Review: ${total} issue(s) found. See output panel before your next sprint.`,
                            'Show Report'
                        ).then(a => { if (a === 'Show Report') { outputChannel.show(true); } });
                    } else {
                        vscode.window.showInformationMessage(
                            `✅ Socratic Milestone Review: Clean. Good start on the next milestone.`
                        );
                    }
                }
            }
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

    // ── Track 2.0: Deep Review command ───────────────────────────────────────
    //
    // Manual trigger for the full-project review. The same review fires
    // automatically after goal inference (onboarding) and milestone updates.

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.deepReview', async () => {
            const goal = getGoal();
            if (!goal) {
                const action = await vscode.window.showWarningMessage(
                    'Socratic: Set a project goal first to enable deep review.',
                    'Set Goal'
                );
                if (action === 'Set Goal') { await promptSetGoal(); }
                return;
            }

            const config = vscode.workspace.getConfiguration('socratic');
            const apiKey = config.get<string>('apiKey', '');
            const model = config.get<string>('model', 'anthropic/claude-sonnet-4');

            if (!apiKey) {
                vscode.window.showWarningMessage('Socratic: Set an API key first (run "Socratic: Set API Key").');
                return;
            }

            const result = await runDeepReview('manual', apiKey, model);
            if (!result) {
                outputChannel.appendLine('⚠ Socratic: Deep review could not complete. Check the output for details.');
                outputChannel.show(true);
                return;
            }

            outputChannel.appendLine(formatDeepReviewReport(result));
            outputChannel.show(true);

            const criticalCount = result.findings.filter(f => f.severity === 'critical').length;
            const highCount = result.findings.filter(f => f.severity === 'high').length;

            if (criticalCount > 0) {
                vscode.window.showWarningMessage(
                    `🔴 Socratic Deep Review: ${criticalCount} critical, ${highCount} high issue(s) found. See output panel.`,
                    'Show Report'
                ).then(a => { if (a === 'Show Report') { outputChannel.show(true); } });
            } else if (highCount > 0) {
                vscode.window.showInformationMessage(
                    `🟠 Socratic Deep Review: ${highCount} high-priority issue(s) found. See output panel.`,
                    'Show Report'
                ).then(a => { if (a === 'Show Report') { outputChannel.show(true); } });
            } else if (result.findings.length > 0) {
                vscode.window.showInformationMessage(
                    `🟡 Socratic Deep Review: ${result.findings.length} medium/low issue(s) found. See output panel.`
                );
            } else {
                vscode.window.showInformationMessage(
                    `✅ Socratic Deep Review: No significant issues found across ${result.files_reviewed} files.`
                );
            }
        })
    );

    // ── Track 3.0: History + Daily Focus commands ─────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.showHistory', async () => {
            const report = await buildTrajectoryReport();
            outputChannel.appendLine(report);
            outputChannel.show(true);
        })
    );

    // Track 1.3: Git hook installer command
    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.installGitHooks', async () => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showWarningMessage('Socratic: No workspace folder open.');
                return;
            }
            await installGitHook(workspaceRoot);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.preShipReview', async () => {
            const goal = getGoal();
            if (!goal) {
                vscode.window.showWarningMessage('Socratic: Set a goal first.');
                return;
            }
            const config = vscode.workspace.getConfiguration('socratic');
            const apiKey = config.get<string>('apiKey', '');
            const model = config.get<string>('model', 'anthropic/claude-sonnet-4');
            if (!apiKey) {
                vscode.window.showWarningMessage('Socratic: Set an API key first.');
                return;
            }
            await runPreShipReview('Manual Command', apiKey, model, outputChannel);
        })
    );

    // ── Startup banner ────────────────────────────────────────────────────────

    const goal = getGoal();
    const config = vscode.workspace.getConfiguration('socratic');
    const apiKey = config.get<string>('apiKey', '');
    const model = config.get<string>('model', 'anthropic/claude-sonnet-4');

    if (!goal) {
        if (apiKey) {
            // Small delay — let VS Code finish loading before showing dialogs.
            // After goal inference, run the onboarding deep review automatically:
            // this gives the developer a baseline before they write a single new line.
            setTimeout(async () => {
                const inferredGoal = await runGoalInference(apiKey, model);
                if (inferredGoal) {
                    // Goal was just set — run the onboarding deep review.
                    // Small extra delay so the constraint picker has time to close.
                    setTimeout(async () => {
                        const result = await runDeepReview('onboarding', apiKey, model);
                        if (result) {
                            outputChannel.appendLine(formatDeepReviewReport(result));
                            outputChannel.show(true);
                            const critical = result.findings.filter(f => f.severity === 'critical').length;
                            const high = result.findings.filter(f => f.severity === 'high').length;
                            if (critical + high > 0) {
                                vscode.window.showWarningMessage(
                                    `🔴 Socratic found ${critical + high} critical/high issue(s) in your current codebase. ` +
                                    `Fix these before building on top of them.`,
                                    'Show Report'
                                ).then(a => { if (a === 'Show Report') { outputChannel.show(true); } });
                            }
                        }
                    }, 2000);
                }
            }, 1500);
        } else {
            outputChannel.appendLine('═══════════════════════════════════════');
            outputChannel.appendLine('  🧠 Socratic AI — Ready');
            outputChannel.appendLine('  Step 1: Run "Socratic: Set API Key"');
            outputChannel.appendLine('  Step 2: Socratic will read your project automatically');
            outputChannel.appendLine('═══════════════════════════════════════');
        }
    } else {
        outputChannel.appendLine(`🎯 Socratic AI V2 active`);
        outputChannel.appendLine(`   Goal: "${goal.goal}"`);
        outputChannel.appendLine(`   Milestone: "${goal.milestone}"`);
        outputChannel.appendLine(`   Run "Socratic: Deep Review" for a full project scan.`);

        // Track 3.0: Daily Focus — heuristic status bar message on every open.
        // Zero LLM calls. Just math: days left + open critical issues + eval detection.
        // This is the "colleague who notices you're running out of time."
        getDailyFocus().then(focus => {
            if (focus) {
                statusBar.text = `$(lightbulb) ${focus}`;
                statusBar.tooltip = focus + '\n\nClick to see current goal.';
            }
        }).catch(() => { /* silent — status bar already set to default */ });
    }
}

export function deactivate() {
    console.log('Socratic AI deactivated');
}

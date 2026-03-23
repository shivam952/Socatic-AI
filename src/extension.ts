/**
 * Socratic AI — Extension Entry Point
 * 
 * "AI that questions your thinking, not writes your code."
 * 
 * This extension proactively reviews your code changes against your
 * stated project goal and warns you about blind spots — before you
 * waste time going the wrong way.
 * 
 * 🏗️ ARCHITECTURE NOTE: Keep It Simple
 * 
 * v0 has no backend, no accounts, no analytics. Everything runs
 * locally in the extension. The LLM is called directly via HTTPS.
 * Project goals are stored in .socratic/goal.json per workspace.
 * 
 * The flow is:
 *   1. User sets a goal → stored in .socratic/goal.json
 *   2. User writes code normally
 *   3. On file save → debounced analysis triggers
 *   4. Context (goal + code + project structure) sent to LLM
 *   5. LLM returns ONE probing question or LGTM
 *   6. Notification shown (or silence if LGTM)
 */
import * as vscode from 'vscode';
import { promptSetGoal, getGoal } from './goal';
import { registerWatcher, triggerAnalysis } from './watcher';
import { initNotifications, initStatusBar } from './notifications';
import { buildContext } from './context';
import { analyzeCode } from './llm';

export function activate(context: vscode.ExtensionContext) {
    console.log('Socratic AI activated');

    // Initialize UI components
    const outputChannel = initNotifications();
    const statusBar = initStatusBar();
    context.subscriptions.push(outputChannel, statusBar);

    // Register commands
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
                    `🎯 Current goal: "${goal.goal}"${goal.context ? ` | Context: ${goal.context}` : ''}`
                );
            } else {
                vscode.window.showInformationMessage(
                    'No goal set. Run "Socratic: Set Project Goal" to get started.'
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('socratic.analyzeNow', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Socratic: No active file to analyze.');
                return;
            }

            const goal = getGoal();
            if (!goal) {
                const setNow = await vscode.window.showWarningMessage(
                    'Socratic: No goal set. Set a goal first?',
                    'Set Goal',
                    'Cancel'
                );
                if (setNow === 'Set Goal') {
                    await promptSetGoal();
                }
                return;
            }

            await triggerAnalysis(editor.document);
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

    // Register the proactive file watcher
    registerWatcher(context);

    // Show welcome message if no goal set
    const goal = getGoal();
    if (!goal) {
        outputChannel.appendLine('═══════════════════════════════════════');
        outputChannel.appendLine('  🧠 Socratic AI — Ready');
        outputChannel.appendLine('  Run "Socratic: Set Project Goal" to start');
        outputChannel.appendLine('  Run "Socratic: Set API Key" to configure');
        outputChannel.appendLine('═══════════════════════════════════════');
    } else {
        outputChannel.appendLine(`🎯 Socratic AI active — Goal: "${goal.goal}"`);
    }
}

export function deactivate() {
    console.log('Socratic AI deactivated');
}

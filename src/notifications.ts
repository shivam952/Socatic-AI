/**
 * Socratic AI — Notifications
 * 
 * Displays proactive warnings as VS Code notifications.
 * Uses the native VS Code notification system — no webview needed for v0.
 * 
 * Severity levels:
 * 🟢 lgtm     → silent (logged to output channel)
 * 🟡 warning  → info notification with actions
 * 🔴 critical → warning notification with actions
 */
import * as vscode from 'vscode';
import { SocraticResponse } from './llm';

let outputChannel: vscode.OutputChannel;

export function initNotifications(): vscode.OutputChannel {
    outputChannel = vscode.window.createOutputChannel('Socratic AI');
    return outputChannel;
}

/**
 * Route internal errors to the output channel — not to console.error.
 * Per error handling policy: all failures are silent to the user,
 * logged to the output channel only, never surfaced as notifications.
 */
export function logError(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    if (outputChannel) {
        outputChannel.appendLine(`[${timestamp}] ⚠️ Socratic (internal): ${message}`);
    }
    // Fallback if called before initNotifications (e.g. during early startup)
    // eslint-disable-next-line no-console
    console.error(`[Socratic] ${message}`);
}

export async function showAnalysisResult(
    result: SocraticResponse,
    fileName: string
): Promise<void> {
    const timestamp = new Date().toLocaleTimeString();

    // Always log to output channel
    outputChannel.appendLine(`\n[${timestamp}] 📄 ${fileName}`);
    outputChannel.appendLine(`  Severity: ${result.severity}`);
    outputChannel.appendLine(`  ${result.message}`);
    if (result.reasoning) {
        outputChannel.appendLine(`  Why: ${result.reasoning}`);
    }
    if (result.alternatives && result.alternatives.length > 0) {
        outputChannel.appendLine(`  Alternatives:`);
        result.alternatives.forEach((alt, i) => {
            outputChannel.appendLine(`    ${i + 1}. ${alt}`);
        });
    }
    outputChannel.appendLine('─'.repeat(60));

    // Show notification based on severity
    if (result.severity === 'lgtm') {
        // Silent — just log. Don't bother the developer when things are fine.
        return;
    }

    const prefix = result.severity === 'critical' ? '🔴' : '🟡';
    const displayMessage = `${prefix} Socratic: ${result.message}`;

    const actions = ['Tell me more', 'Dismiss'];

    let response: string | undefined;
    if (result.severity === 'critical') {
        response = await vscode.window.showWarningMessage(displayMessage, ...actions);
    } else {
        response = await vscode.window.showInformationMessage(displayMessage, ...actions);
    }

    if (response === 'Tell me more') {
        // Show full reasoning in output channel
        outputChannel.show(true);

        if (result.reasoning || (result.alternatives && result.alternatives.length > 0)) {
            let detail = `\n${'═'.repeat(60)}\n`;
            detail += `🔍 DETAILED ANALYSIS — ${fileName}\n`;
            detail += `${'═'.repeat(60)}\n\n`;
            detail += `CONCERN: ${result.message}\n\n`;

            if (result.reasoning) {
                detail += `WHY THIS MATTERS:\n${result.reasoning}\n\n`;
            }

            if (result.alternatives && result.alternatives.length > 0) {
                detail += `ALTERNATIVES TO CONSIDER:\n`;
                result.alternatives.forEach((alt, i) => {
                    detail += `  ${i + 1}. ${alt}\n`;
                });
            }

            detail += `\n${'═'.repeat(60)}\n`;
            outputChannel.appendLine(detail);
        }
    }
}

/**
 * Show a subtle status bar indicator during analysis.
 */
let statusBarItem: vscode.StatusBarItem;

export function initStatusBar(): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.text = '$(lightbulb) Socratic';
    statusBarItem.tooltip = 'Socratic AI — Proactive code review';
    statusBarItem.command = 'socratic.showGoal';
    statusBarItem.show();
    return statusBarItem;
}

export function setAnalyzing(active: boolean): void {
    if (statusBarItem) {
        if (active) {
            statusBarItem.text = '$(sync~spin) Socratic...';
            statusBarItem.tooltip = 'Analyzing your code...';
        } else {
            statusBarItem.text = '$(lightbulb) Socratic';
            statusBarItem.tooltip = 'Socratic AI — Proactive code review';
        }
    }
}

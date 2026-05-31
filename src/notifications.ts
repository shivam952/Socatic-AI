/**
 * Socratic AI — Notifications (V1)
 *
 * Three-level routing for pipeline results:
 *   Level 0 → Silent. Log to output channel only. Never bother the developer.
 *   Level 1 → 🟡 Info notification. Soft interrupt.
 *   Level 2 → 🔴 Warning notification. Hard interrupt.
 *
 * Regret capture: both level 1 and 2 notifications offer action buttons.
 * User response is written back to WarningsLog so the regret rate is trackable.
 *
 * Passive decision capture: "Changed my approach" → prompt for decision record.
 * This feeds the DecisionMemory that makes future Detector runs smarter.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { PipelineResult } from './pipeline';
import { appendWarning, updateWarningOutcome, addDecision } from './memory';
import { runAdvisor } from './advisor';

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

// ─── V1: Pipeline result routing ──────────────────────────────────────────────

/**
 * Route a PipelineResult to the correct notification level and handle
 * regret capture + passive decision logging.
 *
 * Level 0 → log only (silence)
 * Level 1 → 🟡 info notification
 * Level 2 → 🔴 warning notification (hard interrupt)
 */
export async function showPipelineResult(
    result: PipelineResult,
    filePath: string
): Promise<void> {
    const fileName = path.basename(filePath);
    const timestamp = new Date().toLocaleTimeString();

    // Always log to output channel
    outputChannel.appendLine(`\n[${timestamp}] 📄 ${fileName} (level ${result.level})`);
    if (result.level > 0) {
        outputChannel.appendLine(`  ${result.finding.issue_type} — confidence: ${result.finding.confidence}/10`);
        outputChannel.appendLine(`  ${result.message}`);
        if (result.reasoning) {
            outputChannel.appendLine(`  Why: ${result.reasoning}`);
        }
        if (result.alternatives.length > 0) {
            outputChannel.appendLine(`  Alternatives: ${result.alternatives.join(' | ')}`);
        }
    } else {
        outputChannel.appendLine(`  Silent (${result.reasoning})`);
    }
    outputChannel.appendLine('─'.repeat(60));

    // Level 0 → done. Don't bother the developer.
    if (result.level === 0) { return; }

    // Fix 5: Always call appendWarning() here — notifications.ts owns the WarningsLog write.
    // pipeline.ts's warning_id is intentionally not used: the record wasn't written until now.
    // appendWarning() generates its own id which we use for all outcome writebacks.
    const warningId = appendWarning({
        issue_type: result.finding.issue_type,
        message: result.message,
        file_path: filePath,
        output_level: result.level as 0 | 1 | 2,
        outcome: 'unknown',
    });

    // Build the notification
    const prefix = result.level === 2 ? '🔴' : '🟡';
    const displayMessage = `${prefix} Socratic: ${result.message}`;
    const actions = ['Tell me more', 'Changed my approach', 'Not useful', 'Dismiss'];

    let response: string | undefined;
    if (result.level === 2) {
        response = await vscode.window.showWarningMessage(displayMessage, ...actions);
    } else {
        response = await vscode.window.showInformationMessage(displayMessage, ...actions);
    }

    // ── Regret capture ────────────────────────────────────────────────────────

    if (!response || response === 'Dismiss') {
        updateWarningOutcome(warningId, 'dismissed');
        return;
    }

    if (response === 'Not useful') {
        updateWarningOutcome(warningId, 'dismissed');
        return;
    }

    if (response === 'Tell me more') {
        updateWarningOutcome(warningId, 'useful');

        const config = vscode.workspace.getConfiguration('socratic');
        const apiKey = config.get<string>('apiKey', '');
        const model = config.get<string>('model', 'anthropic/claude-sonnet-4');

        if (!apiKey) {
            outputChannel.appendLine('\n⚠️  No API key set — cannot run Advisor.\n');
            outputChannel.show(true);
            return;
        }

        // Show spinner while the Advisor is thinking
        const statusMsg = vscode.window.setStatusBarMessage(
            '$(sync~spin) Socratic: Generating action plan...'
        );

        outputChannel.show(true);
        outputChannel.appendLine(`\n${'═'.repeat(60)}`);
        outputChannel.appendLine(`🔍 ADVISOR — ${fileName}`);
        outputChannel.appendLine(`${'═'.repeat(60)}`);
        outputChannel.appendLine('Analysing your code...\n');

        try {
            const advice = await runAdvisor(
                result.finding.issue_type,
                result.message,
                filePath,
                apiKey,
                model
            );

            // Clear the "Analysing..." line and print the action plan
            outputChannel.appendLine(`CONCERN: ${result.message}\n`);
            outputChannel.appendLine(`ACTION PLAN:`);
            outputChannel.appendLine(advice);
            outputChannel.appendLine(`\n${'═'.repeat(60)}\n`);
        } catch (err: any) {
            outputChannel.appendLine(`Advisor failed: ${err.message}\n`);
        } finally {
            statusMsg.dispose();
        }

        return;
    }

    if (response === 'Changed my approach') {
        // Passive decision capture: user acknowledged a course correction.
        // Prompt for a brief decision record so DecisionMemory stays current.
        updateWarningOutcome(warningId, 'changed_direction');

        const decision = await vscode.window.showInputBox({
            prompt: '📝 What did you decide to do instead? (optional — helps future analysis)',
            placeHolder: 'e.g., Staying with synchronous path until load is measured',
            ignoreFocusOut: true,
        });

        if (decision) {
            addDecision({
                decision,
                rationale: `Captured from Socratic warning: ${result.message.slice(0, 120)}`,
                rejected_alternatives: [],
                source: 'passive',
            });
            vscode.window.showInformationMessage(`📝 Decision logged — "${decision}"`);
        }
    }
}


import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getGoal } from './goal';
import { loadLastDeepReview } from './deep-review';
import { callOpenRouter, extractContent } from './openrouter';
import { logError } from './notifications';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreShipResult {
    ready_to_ship: boolean;
    unresolved_critical_debt: string[];
    constraint_violations: string[];
    milestone_verdict: string;
    final_recommendation: string;
}

// ─── LLM Prompt ───────────────────────────────────────────────────────────────

const PRE_SHIP_SYSTEM_PROMPT = `You are the final gatekeeper for a software release.
Your job is to answer a single question: "Is the developer actually ready to ship this?"

You will receive:
1. The project's current Goal, Constraints, and Milestone Success Metric.
2. The Critical and High severity findings from their last Deep Review (technical debt).
3. The release diff (the code they are about to ship).

Evaluate the following:
1. DEBT CHECK: Look at the unresolved debt from the last review. Were these critical issues fixed in the release diff? Or are they shipping known vulnerabilities/critical bugs?
2. CONSTRAINT CHECK: Does the new code in the release diff violate any stated project constraints?
3. MILESTONE CHECK: Does the codebase currently demonstrate the stated success metric?

Rules:
- Be strict but pragmatic. Don't block a release for minor code smells, but DO block for critical security issues or clear constraint violations.
- "ready_to_ship" must be false if there is unresolved critical debt or constraint violations.
- Output ONLY valid JSON. No markdown fences.

Schema:
{
  "ready_to_ship": boolean,
  "unresolved_critical_debt": ["string array of critical findings from the last review that are still not fixed"],
  "constraint_violations": ["string array of any new constraint violations in the diff"],
  "milestone_verdict": "string explaining if the success metric is met",
  "final_recommendation": "string: 'Ship it' or 'Fix X before tagging'"
}`;

// Token budget: goal+constraints+debt ≈ 2500 chars, output ≈ 1500 tokens.
// That leaves ~6000 chars (~1500 tokens) for the diff before hitting model limits.
const MAX_DIFF_CHARS = 6000;

async function getReleaseDiff(root: string): Promise<string> {
    try {
        // Get the diff of the most recent commit (which triggered this review)
        const gitOut = await new Promise<string>((resolve) => {
            cp.exec(
                'git log -p -1',
                { cwd: root, timeout: 4000 },
                (err, stdout) => resolve(err ? '' : stdout)
            );
        });
        if (gitOut.length <= MAX_DIFF_CHARS) { return gitOut; }
        return gitOut.slice(0, MAX_DIFF_CHARS) +
            `\n...(diff truncated at ${MAX_DIFF_CHARS} chars — review the full diff manually for completeness)`;
    } catch {
        return 'No git diff available.';
    }
}

async function runPreShipReviewLLM(
    apiKey: string,
    model: string,
    root: string
): Promise<PreShipResult | null> {
    const goal = getGoal();
    if (!goal) { return null; }

    const lastReview = await loadLastDeepReview();
    const diff = await getReleaseDiff(root);

    const contextParts: string[] = [
        `PROJECT GOAL: ${goal.goal}`,
        `CURRENT MILESTONE: ${goal.milestone}`,
        `SUCCESS METRIC: ${goal.success_metric}`,
    ];

    if (goal.context) {
        contextParts.push(`TECH CONTEXT: ${goal.context}`);
    }

    let criticalDebt = 'No previous critical debt recorded.';
    if (lastReview && lastReview.findings) {
        const severe = lastReview.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
        if (severe.length > 0) {
            criticalDebt = severe.map(f => `- ${f.file}: ${f.issue} (${f.recommendation})`).join('\n');
        } else {
            criticalDebt = 'No critical/high issues found in the last deep review. Clean slate.';
        }
    }
    
    contextParts.push(`\nUNRESOLVED CRITICAL DEBT (from last review):\n${criticalDebt}`);
    contextParts.push(`\nRELEASE DIFF:\n${diff}`);

    const userPrompt = contextParts.join('\n');

    try {
        const responseText = await callOpenRouter(
            apiKey,
            model,
            PRE_SHIP_SYSTEM_PROMPT,
            userPrompt,
            1000
        );

        const content = extractContent(responseText);
        if (!content) { return null; }

        const cleaned = content
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        const parsed = JSON.parse(cleaned);

        // Sanitize all LLM-generated strings — enforce lengths before persisting
        // to the output channel or surfacing in notifications.
        const capStr = (v: unknown, max = 400): string =>
            String(v || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
        const capArr = (v: unknown, itemMax = 300): string[] =>
            Array.isArray(v)
                ? v.filter(i => typeof i === 'string').map(i => capStr(i, itemMax)).slice(0, 10)
                : [];

        return {
            ready_to_ship: Boolean(parsed.ready_to_ship),
            unresolved_critical_debt: capArr(parsed.unresolved_critical_debt),
            constraint_violations: capArr(parsed.constraint_violations),
            milestone_verdict: capStr(parsed.milestone_verdict),
            final_recommendation: capStr(parsed.final_recommendation),
        };
    } catch (err: any) {
        logError(`Pre-Ship LLM call failed: ${err.message}`);
        return null;
    }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function runPreShipReview(
    triggerSource: string,
    apiKey: string,
    model: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const root = folders[0].uri.fsPath;

    // Show spinner — 60s ceiling so it never persists on crash/hang
    const spinnerMsg = vscode.window.setStatusBarMessage(
        `$(rocket) Socratic: Running Pre-Ship Review (${triggerSource})...`, 60_000
    );

    try {
        const result = await runPreShipReviewLLM(apiKey, model, root);
        if (!result) { return; }

        outputChannel.appendLine(`\n${'═'.repeat(64)}`);
        outputChannel.appendLine(`  🚀 SOCRATIC PRE-SHIP REVIEW`);
        outputChannel.appendLine(`  Trigger: ${triggerSource}`);
        outputChannel.appendLine(`${'═'.repeat(64)}\n`);

        if (result.ready_to_ship) {
            outputChannel.appendLine(`  ✅ VERDICT: READY TO SHIP`);
            outputChannel.appendLine(`  ${result.final_recommendation}\n`);
            outputChannel.appendLine(`  Milestone: ${result.milestone_verdict}\n`);
            vscode.window.showInformationMessage(`✅ Socratic: Ready to ship. No blocking issues found.`, 'Show Report').then(a => {
                if (a) { outputChannel.show(true); }
            });
        } else {
            outputChannel.appendLine(`  🔴 VERDICT: DO NOT SHIP`);
            outputChannel.appendLine(`  ${result.final_recommendation}\n`);
            
            if (result.unresolved_critical_debt.length > 0) {
                outputChannel.appendLine(`  ⚠️  UNRESOLVED DEBT:`);
                result.unresolved_critical_debt.forEach(d => outputChannel.appendLine(`     - ${d}`));
                outputChannel.appendLine('');
            }
            if (result.constraint_violations.length > 0) {
                outputChannel.appendLine(`  🚧 CONSTRAINT VIOLATIONS:`);
                result.constraint_violations.forEach(v => outputChannel.appendLine(`     - ${v}`));
                outputChannel.appendLine('');
            }
            outputChannel.appendLine(`  Milestone: ${result.milestone_verdict}\n`);
            
            vscode.window.showErrorMessage(`🔴 Socratic: Pre-ship review failed. See output panel.`, 'Show Report').then(a => {
                if (a) { outputChannel.show(true); }
            });
        }
        outputChannel.appendLine(`${'═'.repeat(64)}\n`);

    } catch (err: any) {
        logError(`Pre-Ship review failed: ${err.message}`);
    } finally {
        spinnerMsg.dispose();
    }
}

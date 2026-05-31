/**
 * Socratic AI — File Watcher (V1)
 *
 * 🏗️ ARCHITECTURE NOTE: Accumulating Debounce
 *
 * Old v0 behaviour: each save reset a 45s timer ("last event wins").
 * This lost signal — if you added Redis and then edited a config file,
 * only the config file was analysed, not the Redis addition.
 *
 * V1 behaviour: ACCUMULATING debounce.
 *   - Every qualifying save → classify immediately → if not 'none', enqueue the event.
 *   - 15-second window resets on each new save, but events are MERGED, not replaced.
 *   - After 15s silence → call mergeTriggers() on the queue → runPipeline() once.
 *   - This gives the Detector the full picture of what happened in that burst.
 *
 * Error policy: any failure here is caught and logged. The extension
 * never crashes or surfaces its own errors as user-facing notifications.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { getGoal } from './goal';
import { loadMemory } from './memory';
import { classifyTrigger, mergeTriggers, TriggerEvent } from './trigger';
import { runPipeline } from './pipeline';
import { showPipelineResult, logError, setAnalyzing } from './notifications';

// ─── Debounce state ───────────────────────────────────────────────────────────

let debounceTimer: NodeJS.Timeout | undefined;
let pendingEvents: TriggerEvent[] = [];
let analysisLock: Promise<void> = Promise.resolve();

// 7.3: Read from config so users can tune it. Default 15s matches V1 spec.
// The stale package.json default of 45s was the v0 value — now consistent.
function getDebounceMs(): number {
    return vscode.workspace.getConfiguration('socratic').get<number>('debounceSeconds', 15) * 1000;
}

// ─── Level 2 cooldown ─────────────────────────────────────────────────────────

/**
 * Rate limit: at most one Level 2 (hard interrupt) every 8 minutes.
 * Without this, adding Redis + Kafka + Celery in one burst = 3 modal dialogs.
 *
 * Persisted to workspaceState so reloading the VS Code window doesn't reset
 * the cooldown and immediately allow another hard interrupt.
 */
const LEVEL2_COOLDOWN_MS = 8 * 60 * 1000; // 8 minutes
const LEVEL2_STATE_KEY = 'socratic.lastLevel2Timestamp';

// ─── Watcher registration ─────────────────────────────────────────────────────

/**
 * Register the file save watcher on extension activation.
 * Must be called after initializeWorkspaceState() so the known-file
 * baseline is in place before the first save lands.
 */
export function registerWatcher(context: vscode.ExtensionContext): vscode.Disposable {
    const watcher = vscode.workspace.onDidSaveTextDocument((document) => {
        const config = vscode.workspace.getConfiguration('socratic');
        if (!config.get<boolean>('enabled', true)) { return; }

        // Classify immediately — cheap, synchronous
        const event = classifyTrigger(document, context.workspaceState);

        // Only accumulate events worth sending to the pipeline
        if (event.type !== 'none') {
            pendingEvents.push(event);
        }

        // Reset the debounce window regardless (even noise saves reset it —
        // we want the analysis to run after the user settles, not during a burst)
        if (debounceTimer) { clearTimeout(debounceTimer); }

        debounceTimer = setTimeout(async () => {
            const eventsToProcess = [...pendingEvents];
            pendingEvents = []; // Clear before async work so new saves start fresh

            if (eventsToProcess.length === 0) { return; } // Window had only noise saves

            await runAnalysis(eventsToProcess, context);
        }, getDebounceMs()); // 7.3: read from config on each window start
    });

    context.subscriptions.push(watcher);
    return watcher;
}

/**
 * Called by git hooks to process commits immediately.
 * Clears any pending debounce timer and merges its events into the commit run.
 */
export async function clearDebounceAndRunPending(
    commitEvent: TriggerEvent,
    context: vscode.ExtensionContext
): Promise<void> {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }

    const eventsToProcess = [...pendingEvents, commitEvent];
    pendingEvents = [];

    await runAnalysis(eventsToProcess, context);
}

// ─── Analysis runner ──────────────────────────────────────────────────────────

/**
 * Run the full trigger→pipeline flow for accumulated events.
 * Called by the debounce timer and by socratic.analyzeNow.
 */
export async function runAnalysis(
    events: TriggerEvent[],
    context: vscode.ExtensionContext
): Promise<void> {
    const goal = getGoal();
    if (!goal) {
        // No goal set — silently skip. Nagging the user without goal context is
        // worse than silence. Extension shows a reminder in the status bar.
        return;
    }

    // Merge accumulated events into one pipeline run
    const mergedTrigger = mergeTriggers(events);

    const memory = loadMemory(goal);

    const currentLock = analysisLock;
    let releaseLock: () => void;
    analysisLock = new Promise(resolve => { releaseLock = resolve; });

    // Wait for any in-flight analysis to finish before starting this one
    await currentLock;

    setAnalyzing(true);
    try {
        const result = await runPipeline(mergedTrigger, memory);

        // 8-minute cooldown between Level 2 hard interrupts.
        // Read from / write to workspaceState so the cooldown survives window reloads.
        // 7.4: Spread into a new object instead of mutating the returned result.
        let finalResult = result;
        if (result.level === 2) {
            const now = Date.now();
            const lastLevel2Timestamp = context.workspaceState.get<number>(LEVEL2_STATE_KEY, 0);
            if (now - lastLevel2Timestamp < LEVEL2_COOLDOWN_MS) {
                finalResult = { ...result, level: 1 as import('./pipeline').OutputLevel };
            } else {
                context.workspaceState.update(LEVEL2_STATE_KEY, now);
            }
        }

        await showPipelineResult(finalResult, mergedTrigger.file_path);
    } catch (err: any) {
        // Per error policy: log, never surface to the user
        logError(`Analysis failed: ${err.message}`);
    } finally {
        setAnalyzing(false);
        releaseLock!();
    }
}

/**
 * Manual trigger — used by socratic.analyzeNow command.
 * Synthesises a 'manual_checkpoint' TriggerEvent from the currently
 * active editor document so the pipeline has a concrete file to reason about.
 */
export async function triggerManualAnalysis(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Socratic: Open a file first.');
        return;
    }
    const doc = editor.document;
    const fileName = path.basename(doc.fileName);

    const manualEvent: TriggerEvent = {
        type: 'manual_checkpoint',
        evidence: [
            `Manual analysis requested on ${fileName}`,
            `File contents (first 2000 chars):\n${doc.getText().slice(0, 2000)}`,
        ],
        diff_summary: `Manual checkpoint — user requested analysis on ${fileName}`,
        file_path: doc.fileName,
    };

    await runAnalysis([manualEvent], context);
}

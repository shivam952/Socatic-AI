/**
 * Socratic AI — Structured Memory (V1)
 *
 * Single source of truth for all persistent project state:
 *   - GoalMemory      (.socratic/goal.json)
 *   - ConstraintMemory (.socratic/constraints.json)
 *   - DecisionMemory   (.socratic/decisions.json)
 *   - WarningsLog      (.socratic/warnings-log.json)
 *
 * 🏗️ ARCHITECTURE NOTE: Memory Quality = Warning Quality
 *
 * The Detector LLM is only as good as what it can cite.
 * Every field in these schemas exists to give the Detector
 * concrete evidence to reference — not just vague context.
 *
 * Decision Memory is the most critical:
 * "This contradicts your earlier decision to postpone Redis."
 * That sentence is only possible if we have structured decisions.
 *
 * Token budget priority (enforced in pipeline.ts):
 *   1. Goal + milestone (never truncate)
 *   2. Constraints     (never truncate — small)
 *   3. Last 5 decisions (truncate older ones first)
 *   4. Expert rules    (drop examples if tight)
 *   5. Diff summary    (max 500 tokens)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GoalMemory, getSocraticDir, ensureSocraticDir } from './goal';
import { logError } from './notifications';

// ─── Schemas (mirrors V1_SPEC.md exactly) ─────────────────────────────────────

export interface ConstraintMemory {
    constraints: string[];
}

export interface DecisionRecord {
    id: string;
    decision: string;
    rationale: string;
    rejected_alternatives: string[];
    timestamp: string;
    source: 'manual' | 'passive'; // passive = captured via "changed approach" response
}

export interface DecisionMemory {
    decisions: DecisionRecord[];
}

export interface WarningRecord {
    id: string;
    timestamp: string;
    issue_type: string;
    message: string;
    file_path: string;
    output_level: 0 | 1 | 2;
    outcome: 'dismissed' | 'useful' | 'changed_direction' | 'unknown';
}

export interface WarningsLog {
    warnings: WarningRecord[];
}

// ─── Full assembled memory payload (what the pipeline receives) ───────────────

export interface ProjectMemory {
    goal: GoalMemory;
    constraints: ConstraintMemory;
    decisions: DecisionMemory;
    recent_warnings: RecentWarning[]; // last 5 within time window (for dedup + novelty)
}

// ─── File path helpers ────────────────────────────────────────────────────────

function getFilePath(filename: string): string | undefined {
    const dir = getSocraticDir();
    return dir ? path.join(dir, filename) : undefined;
}

// ─── Generic read/write helpers ───────────────────────────────────────────────

function readJson<T>(filename: string, defaultValue: T): T {
    const filePath = getFilePath(filename);
    if (!filePath || !fs.existsSync(filePath)) {
        return defaultValue;
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as T;
    } catch {
        logError(`Failed to parse ${filename}, using empty default.`);
        return defaultValue;
    }
}

function writeJson<T>(filename: string, data: T): void {
    const filePath = getFilePath(filename);
    if (!filePath) { return; }
    ensureSocraticDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Constraints ─────────────────────────────────────────────────────────────

export function getConstraints(): ConstraintMemory {
    return readJson<ConstraintMemory>('constraints.json', { constraints: [] });
}

export function saveConstraints(memory: ConstraintMemory): void {
    writeJson('constraints.json', memory);
}

export function addConstraint(constraint: string): void {
    const current = getConstraints();
    current.constraints.push(constraint);
    saveConstraints(current);
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export function getDecisions(): DecisionMemory {
    return readJson<DecisionMemory>('decisions.json', { decisions: [] });
}

export function saveDecisions(memory: DecisionMemory): void {
    writeJson('decisions.json', memory);
}

export function addDecision(record: Omit<DecisionRecord, 'id' | 'timestamp'>): DecisionRecord {
    const current = getDecisions();
    const newRecord: DecisionRecord = {
        ...record,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
    };
    current.decisions.push(newRecord);
    saveDecisions(current);
    return newRecord;
}

/**
 * Returns the N most recent decisions (for token budget compliance).
 * Never returns a random subset — always tail of the list.
 */
export function getRecentDecisions(n: number = 5): DecisionRecord[] {
    const all = getDecisions().decisions;
    return all.slice(-n);
}

// ─── Warnings Log ─────────────────────────────────────────────────────────────

// Hard cap on retained warnings. Keeps the file bounded at ~200KB worst-case
// and prevents the per-pipeline readFileSync from growing without limit.
const MAX_WARNINGS_RETAINED = 500;

// In-process lock: appendWarning and updateWarningOutcome both do
// read→modify→write. Without a lock, two concurrent async callers can race
// and the second write silently overwrites the first.
// This simple boolean is enough because VS Code's extension host is
// single-threaded — only one microtask runs at a time. If we're mid-write
// we queue the next operation rather than letting it overwrite.
let warningsWritePending = false;
const warningsWriteQueue: (() => void)[] = [];

function flushWarningsQueue(): void {
    const next = warningsWriteQueue.shift();
    if (next) {
        next();
    } else {
        warningsWritePending = false;
    }
}

function serializedWarningsWrite(fn: () => void): void {
    if (warningsWritePending) {
        warningsWriteQueue.push(() => { fn(); flushWarningsQueue(); });
    } else {
        warningsWritePending = true;
        fn();
        flushWarningsQueue();
    }
}

export function getWarningsLog(): WarningsLog {
    return readJson<WarningsLog>('warnings-log.json', { warnings: [] });
}

export function saveWarningsLog(log: WarningsLog): void {
    // Prune to MAX_WARNINGS_RETAINED before every write — keeps file bounded.
    if (log.warnings.length > MAX_WARNINGS_RETAINED) {
        log.warnings = log.warnings.slice(-MAX_WARNINGS_RETAINED);
    }
    writeJson('warnings-log.json', log);
}

export function appendWarning(record: Omit<WarningRecord, 'id' | 'timestamp'>): string {
    const id = crypto.randomUUID();
    serializedWarningsWrite(() => {
        const log = getWarningsLog();
        log.warnings.push({
            ...record,
            id,
            timestamp: new Date().toISOString(),
        });
        saveWarningsLog(log);
    });
    return id;
}

export function updateWarningOutcome(
    warningId: string,
    outcome: WarningRecord['outcome']
): void {
    serializedWarningsWrite(() => {
        const log = getWarningsLog();
        const idx = log.warnings.findIndex(w => w.id === warningId);
        if (idx !== -1) {
            log.warnings[idx].outcome = outcome;
            saveWarningsLog(log);
        }
    });
}

// Dedup protects against rapid re-fires in the debounce window, not session-wide.
// 5 minutes is long enough to catch the debounce overlap, short enough to let
// genuinely new warnings about different files through.
const RECENT_WARNINGS_WINDOW_MS = 5 * 60 * 1000;

export interface RecentWarning {
    message: string;
    file_path: string;
}

export function getRecentWarnings(n: number = 5): RecentWarning[] {
    const log = getWarningsLog();
    const cutoff = Date.now() - RECENT_WARNINGS_WINDOW_MS;
    return log.warnings
        .filter(w => new Date(w.timestamp).getTime() > cutoff)
        .slice(-n)
        .map(w => ({ message: w.message, file_path: w.file_path }));
}

// ─── Full memory loader (single call for pipeline) ────────────────────────────

export function loadMemory(goal: GoalMemory): ProjectMemory {
    return {
        goal,
        constraints: getConstraints(),
        decisions: { decisions: getRecentDecisions(5) },
        recent_warnings: getRecentWarnings(5),
    };
}

// ─── Regret summary (for showWarningsLog command) ────────────────────────────

export function getWarningsSummary(): string {
    const log = getWarningsLog();
    const total = log.warnings.length;
    const useful = log.warnings.filter(w => w.outcome === 'useful').length;
    const changed = log.warnings.filter(w => w.outcome === 'changed_direction').length;
    const dismissed = log.warnings.filter(w => w.outcome === 'dismissed').length;
    const unknown = log.warnings.filter(w => w.outcome === 'unknown').length;

    const lines = [
        `═══════════════════════════════════════`,
        `  Socratic AI — Warnings Summary`,
        `═══════════════════════════════════════`,
        `  Total interruptions : ${total}`,
        `  Useful              : ${useful}`,
        `  Changed approach    : ${changed}`,
        `  Dismissed           : ${dismissed}`,
        `  No response         : ${unknown}`,
        `  Regret rate         : ${total > 0 ? Math.round((dismissed / total) * 100) : 0}%`,
        `═══════════════════════════════════════`,
    ];

    log.warnings.slice(-20).reverse().forEach(w => {
        const icon = w.outcome === 'useful' ? '✅' :
                     w.outcome === 'changed_direction' ? '🔄' :
                     w.outcome === 'dismissed' ? '❌' : '❓';
        lines.push(`\n${icon} [${new Date(w.timestamp).toLocaleDateString()}] L${w.output_level} — ${w.file_path}`);
        lines.push(`   ${w.message}`);
        lines.push(`   Outcome: ${w.outcome}`);
    });

    return lines.join('\n');
}

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
import { GoalMemory, getSocraticDir, ensureSocraticDir } from './goal';
import { logError } from './notifications';
import { v4 as uuidv4 } from 'uuid';

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
    recent_warnings: string[]; // last 5 message strings (for novelty check)
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
        id: uuidv4(),
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

export function getWarningsLog(): WarningsLog {
    return readJson<WarningsLog>('warnings-log.json', { warnings: [] });
}

export function saveWarningsLog(log: WarningsLog): void {
    writeJson('warnings-log.json', log);
}

export function appendWarning(record: Omit<WarningRecord, 'id' | 'timestamp'>): string {
    const log = getWarningsLog();
    const id = uuidv4();
    log.warnings.push({
        ...record,
        id,
        timestamp: new Date().toISOString(),
    });
    saveWarningsLog(log);
    return id;
}

export function updateWarningOutcome(
    warningId: string,
    outcome: WarningRecord['outcome']
): void {
    const log = getWarningsLog();
    const idx = log.warnings.findIndex(w => w.id === warningId);
    if (idx !== -1) {
        log.warnings[idx].outcome = outcome;
        saveWarningsLog(log);
    }
}

export function getRecentWarningMessages(n: number = 5): string[] {
    const log = getWarningsLog();
    return log.warnings
        .slice(-n)
        .map(w => w.message);
}

// ─── Full memory loader (single call for pipeline) ────────────────────────────

export function loadMemory(goal: GoalMemory): ProjectMemory {
    return {
        goal,
        constraints: getConstraints(),
        decisions: { decisions: getRecentDecisions(5) },
        recent_warnings: getRecentWarningMessages(5),
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

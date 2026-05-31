/**
 * Socratic AI — Two-Stage Pipeline (V1)
 *
 * Takes a TriggerEvent + ProjectMemory → produces a PipelineResult (level 0/1/2).
 *
 * 🏗️ ARCHITECTURE NOTE: Why Two Stages?
 *
 * Stage 1 — Detector: "Is there a real concern here?"
 *   Calls the LLM with full context. Produces a structured finding.
 *   Might hallucinate, over-trigger, or flag things already decided.
 *
 * Stage 2 — Verifier: "Should we actually interrupt the developer?"
 *   Audits the Detector output against memory (known constraints, past
 *   decisions, recent warnings). It's the quality gate that makes
 *   Socratic's "rarely speaks, always right" policy hold.
 *
 * Output levels:
 *   0 → Silent (LGTM or redundant). Log only.
 *   1 → Soft notification (🟡 warning — worth considering).
 *   2 → Hard interrupt (🔴 critical — clear misalignment with goal).
 *
 * Error policy: ALL failures in this file are caught, logged to the
 * output channel, and return level 0. The extension NEVER crashes or
 * surfaces a popup about its own internal failures.
 *
 * Token budget (enforced in buildDetectorPrompt):
 *   Priority 1 — Goal + milestone        (never truncate)
 *   Priority 2 — Constraints             (never truncate — small)
 *   Priority 3 — Last 5 decisions        (truncate older first)
 *   Priority 4 — Expert rules            (drop examples if tight)
 *   Priority 5 — Diff summary / evidence (max ~500 tokens / ~2000 chars)
 *   Hard ceiling: 4000 tokens (~16000 chars) total prompt
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TriggerEvent } from './trigger';
import { ProjectMemory, DecisionRecord } from './memory';
import { logError } from './notifications';
import { callOpenRouter, extractContent } from './openrouter';
import { ALL_RULE_PACKS } from './expert-rules/index';

// ─── Expert rule pack type ─────────────────────────────────────────────────────
// Typed to match premature-complexity.json exactly — any schema mismatch is a
// compile error, not a silent runtime undefined.
interface RulePack {
    domain: string;
    version: string;
    mistake_family: string;
    description: string;
    warning_signs: string[];
    rubric: string[];                   // Top-level array of rubric questions
    trigger_keywords: {
        dependencies: string[];
        file_patterns: string[];
        infra_directories: string[];
    };
    good_warning_examples: string[];    // Top-level — NOT nested under 'examples'
    bad_warning_examples: string[];     // Top-level — NOT nested under 'examples'
    threshold: {
        min_confidence_for_candidate: number;
        min_confidence_for_level2: number;
        rubric_hits_for_strong_signal: number;
    };
}

// All packs are cast to RulePack at the usage site via ALL_RULE_PACKS.

// ─── Public interface ─────────────────────────────────────────────────────────

export type OutputLevel = 0 | 1 | 2;

export interface PipelineResult {
    level: OutputLevel;
    /** The Socratic question to show the developer. Empty string if level 0. */
    message: string;
    /** Why this matters — shown on "Tell me more". */
    reasoning: string;
    /** Alternative approaches to consider. */
    alternatives: string[];
    /** The Detector's raw finding — kept for the Verifier and logging. */
    finding: DetectorFinding;
    // Note: warning_id removed — notifications.ts owns WarningsLog writes and
    // generates the id itself via appendWarning(). Keeping id generation in
    // pipeline.ts was wrong because appendWarning() was never called there.
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface DetectorFinding {
    /** 'lgtm' | 'concern' */
    verdict: string;
    /** Short type label matching expert-rule categories. */
    issue_type: string;
    /** The main concern message (the question to ask). */
    message: string;
    /** Why this matters. */
    reasoning: string;
    /** Alternative approaches. */
    alternatives: string[];
    /**
     * 0–10 confidence. Below 5 → Verifier should downgrade or silence.
     * This is the Detector being honest about its own uncertainty.
     */
    confidence: number;
}

interface VerifierDecision {
    approved: boolean;
    level: OutputLevel;
    /** Why the Verifier downgraded or killed the finding. */
    rationale: string;
}

// ─── Token budget constants ───────────────────────────────────────────────────

const MAX_PROMPT_CHARS = 16_000;    // ~4000 tokens at 4 chars/token
const MAX_EVIDENCE_CHARS = 2_000;   // ~500 tokens — diff summary budget
const MAX_DECISION_CHARS = 3_000;   // ~750 tokens — decisions section budget

// ─── Stage 1: Detector ───────────────────────────────────────────────────────

/**
 * Build the Detector user prompt, enforcing token budget.
 * Sections are added in priority order; lower-priority sections
 * are truncated or omitted when the budget is exhausted.
 */
function buildDetectorPrompt(trigger: TriggerEvent, memory: ProjectMemory): string {
    const { goal, constraints, decisions, recent_warnings } = memory;

    const sections: string[] = [];
    let charCount = 0;

    // ── Priority 1: Goal + Milestone (never truncate) ──────────────────────
    const goalSection = [
        `PROJECT GOAL: ${goal.goal}`,
        `CURRENT MILESTONE: ${goal.milestone}`,
        `SUCCESS METRIC: ${goal.success_metric}`,
        `TIME HORIZON: ${goal.time_horizon}`,
        goal.context ? `TECH CONTEXT: ${goal.context}` : '',
    ].filter(Boolean).join('\n');
    sections.push(goalSection);
    charCount += goalSection.length;

    // ── Priority 2: Constraints (never truncate) ────────────────────────────
    if (constraints.constraints.length > 0) {
        const constraintSection = `KNOWN CONSTRAINTS (do not suggest violating these):\n${
            constraints.constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
        }`;
        sections.push(constraintSection);
        charCount += constraintSection.length;
    }

    // ── Priority 3: Last 5 decisions (truncate older ones first) ───────────
    const recentDecisions: DecisionRecord[] = decisions.decisions.slice(-5);
    if (recentDecisions.length > 0) {
        let decisionText = 'PAST DECISIONS (if this contradicts one, say so explicitly):\n';
        let decisionChars = decisionText.length;

        for (const d of recentDecisions) {
            const line = `  • [${new Date(d.timestamp).toLocaleDateString()}] ${d.decision}` +
                (d.rationale ? ` — Rationale: ${d.rationale}` : '') +
                (d.rejected_alternatives.length > 0
                    ? ` — Rejected: ${d.rejected_alternatives.join(', ')}`
                    : '') + '\n';
            if (charCount + decisionChars + line.length < MAX_PROMPT_CHARS - MAX_EVIDENCE_CHARS) {
                decisionText += line;
                decisionChars += line.length;
            }
        }

        if (decisionChars <= MAX_DECISION_CHARS) {
            sections.push(decisionText.trimEnd());
            charCount += decisionChars;
        }
    }

    // ── Priority 4: Expert rules from ALL packs (drop examples if tight) ──────
    const budgetAfterMemory = MAX_PROMPT_CHARS - charCount - MAX_EVIDENCE_CHARS;
    if (budgetAfterMemory > 500) {
        let rulesSection = `EXPERT RUBRICS — flag concerns from ANY of these mistake families:\n`;

        for (const pack of ALL_RULE_PACKS) {
            const p = pack as unknown as RulePack;
            rulesSection += `\n[${p.mistake_family.toUpperCase()}]\n`;
            rulesSection += `  Watch for: ${p.trigger_keywords.dependencies.slice(0, 5).join(', ')}\n`;
            rulesSection += `  Ask yourself:\n${
                p.rubric.slice(0, 3).map((q, i) => `    ${i + 1}. ${q}`).join('\n')
            }\n`;
        }

        if (budgetAfterMemory > 2500) {
            for (const pack of ALL_RULE_PACKS) {
                const p = pack as unknown as RulePack;
                const good = p.good_warning_examples[0];
                if (good) {
                    rulesSection += `\nGood ${p.mistake_family} warning: ${good}\n`;
                }
            }
        }

        sections.push(rulesSection.trimEnd());
        charCount += rulesSection.length;
    }

    // ── Priority 5: Trigger evidence + diff summary ─────────────────────────
    let evidence = trigger.evidence.join('\n');
    if (evidence.length > MAX_EVIDENCE_CHARS) {
        evidence = evidence.slice(0, MAX_EVIDENCE_CHARS) + '\n...(truncated)';
    }
    const triggerSection = [
        `\nTRIGGER EVENT: ${trigger.type}`,
        `FILE: ${path.basename(trigger.file_path)}`,
        `SUMMARY: ${trigger.diff_summary}`,
        `EVIDENCE:\n${evidence}`,
    ].join('\n');
    sections.push(triggerSection);

    // ── Novelty check: recent warnings ─────────────────────────────────────
    if (recent_warnings.length > 0) {
        sections.push(
            `RECENT WARNINGS (do NOT repeat these):\n${
                recent_warnings.map((w, i) => `  ${i + 1}. ${w.message}`).join('\n')
            }`
        );
    }

    sections.push(
        '\nBased on the trigger event and project context, identify ONE specific concern. ' +
        'BEFORE returning lgtm, CHECK EVERY CONSTRAINT above against this trigger. ' +
        'If any constraint even partially conflicts with this action, return verdict "concern". ' +
        'If nothing is actually concerning relative to this goal, milestone, AND all constraints, respond with verdict "lgtm". ' +
        'Be specific — reference the actual file name and trigger type.'
    );

    return sections.join('\n\n');
}

// The contract between prompt output and Verifier gates (G4/G5) must be explicit —
// if the LLM doesn't know these exact strings exist, it won't use them reliably.
const DETECTOR_SYSTEM_PROMPT = `You are the Detector stage of Socratic AI — a senior engineer reviewing a code decision event.

YOUR TASK:
Given a trigger event (new dependency, new file, config change, etc.) and full project context,
identify ONE specific concern about whether this decision aligns with the developer's current goal and milestone.

CRITICAL — CONSTRAINT CHECK PROTOCOL:
Before returning "lgtm", you MUST check every single KNOWN CONSTRAINT listed in the context.
For each constraint, ask: "Does this trigger event introduce something that the constraint explicitly forbids?"
If ANY constraint is violated — even partially — you MUST return verdict "concern" with issue_type "violates_constraint".
Examples of constraint violations:
  - Constraint says "no cloud infra until X" → adding redis, celery, kafka, or any broker/queue IS a violation
  - Constraint says "SQLite only" → adding postgres, mysql IS a violation
  - Constraint says "local-first" → adding any managed service SDK IS a violation
Do NOT rationalize why the violation might be acceptable. Flag it. Let the human decide.

RULES:
1. ONE concern only. Not a list. Not a lecture.
2. ONLY return "lgtm" if you have checked every constraint and none apply. When in doubt, flag it.
3. Reference the actual trigger type and file name in your message.
4. If this directly contradicts a PAST DECISION listed in the context, you MUST use issue_type "contradicts_decision".
5. If this directly violates a KNOWN CONSTRAINT listed in the context, you MUST use issue_type "violates_constraint".
6. Be honest about your confidence (0–10). Below 5 means you're guessing.
7. Bias toward action: a false alarm is better than a missed constraint violation.

RESPOND IN THIS EXACT JSON FORMAT:
{
  "verdict": "lgtm" | "concern",
  "issue_type": "premature_complexity" | "scope_creep" | "dependency_sprawl" | "architecture_contradiction" | "contradicts_decision" | "violates_constraint" | "infra_mismatch" | "other" | null,
  "message": "Your one probing question (2-3 sentences max)" | null,
  "reasoning": "Why this matters for their milestone (1-2 sentences)" | null,
  "alternatives": ["Alternative 1", "Alternative 2"] | null,
  "confidence": 7
}

For "lgtm" responses, issue_type/message/reasoning/alternatives may be null. For "concern" responses, ALL fields must be populated.`;

/**
 * Stage 1: Call the LLM to detect a potential concern.
 */
async function runDetector(
    trigger: TriggerEvent,
    memory: ProjectMemory,
    apiKey: string,
    model: string
): Promise<DetectorFinding | null> {
    const userPrompt = buildDetectorPrompt(trigger, memory);

    try {
        const responseText = await callOpenRouter(
            apiKey,
            model,
            DETECTOR_SYSTEM_PROMPT,
            userPrompt,
            600  // Detector gets 600 tokens max — focused output
        );

        const content = extractContent(responseText);
        if (!content) { return null; }

        try {
            const parsed = JSON.parse(content) as DetectorFinding;

            // 7.8: Minimal shape check — verdict and confidence are always required.
            // For "concern" verdicts, message must also be a string.
            // For "lgtm" verdicts, message/reasoning/alternatives may be null.
            if (
                typeof parsed.verdict !== 'string' ||
                typeof parsed.confidence !== 'number'
            ) {
                logError(`Detector returned malformed shape: ${content.slice(0, 150)}`);
                return null;
            }

            // Concern verdicts must have a message — otherwise there's nothing to show
            if (parsed.verdict === 'concern' && typeof parsed.message !== 'string') {
                logError(`Detector returned concern without message: ${content.slice(0, 150)}`);
                return null;
            }

            // Validate issue_type is a known value. A typo like "violates_constraints"
            // would silently fall through G4/G5 (strict equality) and become Level 1
            // instead of the intended Level 2. Log and normalise to 'other'.
            const KNOWN_ISSUE_TYPES = new Set([
                'premature_complexity', 'scope_creep', 'dependency_sprawl',
                'architecture_contradiction', 'contradicts_decision',
                'violates_constraint', 'infra_mismatch', 'other',
            ]);
            if (parsed.issue_type && !KNOWN_ISSUE_TYPES.has(parsed.issue_type)) {
                logError(`Detector returned unknown issue_type "${parsed.issue_type}" — normalising to "other".`);
                parsed.issue_type = 'other';
            }

            // Cap alternatives array to 5 — prevents a verbose LLM from
            // logging 20-item lists in the output channel.
            if (Array.isArray(parsed.alternatives) && parsed.alternatives.length > 5) {
                parsed.alternatives = parsed.alternatives.slice(0, 5);
            }

            return parsed;
        } catch {
            // LLM didn't return valid JSON — treat as lgtm
            logError(`Detector returned non-JSON: ${content.slice(0, 100)}`);
            return null;
        }
    } catch (err: any) {
        logError(`Detector call failed: ${err.message}`);
        return null;
    }
}

// ─── Stage 2: Verifier ───────────────────────────────────────────────────────

/**
 * Verify the Detector's finding locally (no LLM call — fast, deterministic).
 *
 * This is intentionally rule-based, not another LLM call. The Verifier's
 * job is mechanical: apply the quality gates that the Detector can't reliably
 * apply to itself.
 *
 * Gates (in order):
 *   G1. Detector said lgtm → level 0, done.
 *   G2. Confidence < 5 → downgrade to level 0 (Detector is guessing).
 *   G3. Message is duplicate of a recent warning → level 0.
 *   G4. issue_type === 'violates_constraint' → escalate to level 2.
 *   G5. issue_type === 'contradicts_decision' → level 2.
 *   G6. trigger.type === 'new_infra' or 'new_service' → floor at level 1.
 *   G7. Default → level 1.
 */
function runVerifier(
    finding: DetectorFinding,
    trigger: TriggerEvent,
    memory: ProjectMemory
): VerifierDecision {

    // G1: LGTM — silence.
    if (finding.verdict === 'lgtm') {
        return { approved: false, level: 0, rationale: 'Detector found no concern.' };
    }

    // G2: Low confidence — don't interrupt developer over guesswork.
    if (finding.confidence < 5) {
        return {
            approved: false,
            level: 0,
            rationale: `Detector confidence too low (${finding.confidence}/10) — suppressed.`,
        };
    }

    // G3: Duplicate recent warning — novelty check.
    // Two conditions must BOTH be true to suppress:
    //   1. Same file (different files = different concerns, never dedup)
    //   2. 5+ overlapping content words (>4 chars to skip domain noise)
    const triggerFile = path.basename(trigger.file_path);
    const isDuplicate = memory.recent_warnings.some(w => {
        // Different file? Never a duplicate.
        if (path.basename(w.file_path) !== triggerFile) { return false; }
        const wWords = new Set(w.message.toLowerCase().split(/\s+/).filter(t => t.length > 4));
        const mWords = finding.message.toLowerCase().split(/\s+/).filter(t => t.length > 4);
        const overlap = mWords.filter(word => wWords.has(word)).length;
        return overlap >= 5;
    });

    if (isDuplicate) {
        return {
            approved: false,
            level: 0,
            rationale: 'Suppressed: overlaps with a recent warning already shown.',
        };
    }

    // G4: Constraint violation — confidence-gated.
    // High confidence (≥8) → level 2 hard interrupt. The Detector is sure.
    // Lower confidence → level 1. Ambiguous violations (e.g. openai for embeddings
    // vs. openai for LLM inference) should be a question, not a red alarm.
    if (finding.issue_type === 'violates_constraint') {
        const level = finding.confidence >= 8 ? 2 : 1;
        return {
            approved: true,
            level,
            rationale: level === 2
                ? 'Escalated: high-confidence constraint violation.'
                : 'Soft alert: possible constraint violation — Detector confidence below 8.',
        };
    }

    // G5: Contradicts a past decision — confidence-gated for the same reason.
    if (finding.issue_type === 'contradicts_decision') {
        const level = finding.confidence >= 8 ? 2 : 1;
        return {
            approved: true,
            level,
            rationale: level === 2
                ? 'Escalated: high-confidence decision contradiction.'
                : 'Soft alert: possible decision contradiction — Detector confidence below 8.',
        };
    }

    // G6: High-signal trigger type → floor at level 1.
    if (trigger.type === 'new_infra' || trigger.type === 'new_service') {
        return {
            approved: true,
            level: finding.confidence >= 8 ? 2 : 1,
            rationale: `High-signal trigger type (${trigger.type}).`,
        };
    }

    // G7: Default → level 1 (soft notification).
    return { approved: true, level: 1, rationale: 'Standard concern — notify without interrupting.' };
}

// ─── Public entrypoint ────────────────────────────────────────────────────────

/**
 * Run the full two-stage pipeline for a trigger event.
 *
 * Returns a PipelineResult. Level 0 means silence — the caller
 * should log it but not show a notification.
 *
 * This function NEVER throws. All errors are caught and return level 0.
 */
export async function runPipeline(
    trigger: TriggerEvent,
    memory: ProjectMemory
): Promise<PipelineResult> {
    const silentResult = (finding: DetectorFinding, rationale: string): PipelineResult => ({
        level: 0,
        message: '',
        reasoning: rationale,
        alternatives: [],
        finding,
    });

    const noopFinding: DetectorFinding = {
        verdict: 'lgtm',
        issue_type: 'other',
        message: '',
        reasoning: '',
        alternatives: [],
        confidence: 0,
    };

    // Gate: never run pipeline if trigger is noise
    if (trigger.type === 'none') {
        return silentResult(noopFinding, 'Trigger type is none — no pipeline run.');
    }

    const config = vscode.workspace.getConfiguration('socratic');
    const apiKey = config.get<string>('apiKey', '');
    const model = config.get<string>('model', 'anthropic/claude-sonnet-4');

    if (!apiKey) {
        logError('Pipeline skipped: no API key configured.');
        return silentResult(noopFinding, 'No API key configured.');
    }

    // ── Stage 1: Detector ──────────────────────────────────────────────────
    const finding = await runDetector(trigger, memory, apiKey, model);

    if (!finding) {
        return silentResult(noopFinding, 'Detector returned no finding.');
    }

    // ── Stage 2: Verifier ──────────────────────────────────────────────────
    const verifierDecision = runVerifier(finding, trigger, memory);

    if (!verifierDecision.approved) {
        return silentResult(finding, verifierDecision.rationale);
    }

    // notifications.ts is responsible for creating the WarningsLog entry
    // and generating the id via appendWarning().
    return {
        level: verifierDecision.level,
        message: finding.message,
        reasoning: finding.reasoning,
        alternatives: finding.alternatives || [],
        finding,
    };
}



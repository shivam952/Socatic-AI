# Socratic AI

> "AI that questions your thinking, not writes your code."

## What This Is

A VS Code extension that acts as a proactive senior engineer. It watches for high-signal development events, scores candidate issues against strict criteria, and — only when confidence is high — asks ONE sharp Socratic question. It never writes code. It never gives advice unprompted. It stays silent most of the time, and that silence is intentional.

The goal is not maximum helpfulness. The goal is minimum regret per interruption.

## The Contrarian Bet

Every other AI dev tool competes on "write code faster." Socratic AI is on a completely different axis: make the developer *think* better. When AI gives you the answer, you ship faster but understand less. Socratic AI makes developers better, not just faster.

The market is racing to replace human thinking. We believe AI is best used to train and sharpen it.

## Core Design Principles — Follow These Always

1. **Narrow judgment, not general intelligence.** The tool judges only 5 classes of issues. It does not opine on architecture generally, suggest best practices, or give ideas. Scope collapse = quality collapse.
2. **Checkpoints, not continuous watching.** It triggers on decision-like events, not every save. Trigger quality determines signal quality.
3. **Confidence gate before every interruption.** Every candidate warning is scored. If any scoring dimension is weak, it stays silent. Silence is the default.
4. **Structured reasoning before natural language.** The model fills a strict internal JSON structure before rendering any user-facing message. No free-form rambling.
5. **Two-stage detection.** A Detector proposes candidate issues. A Verifier decides if they're worth surfacing. One model pass is always overconfident.
6. **Three output levels.** Level 0 = silence. Level 1 = panel note only. Level 2 = interrupt. Most outputs should die at Level 0.
7. **Every interruption cites its basis.** A warning must trace to a goal, a constraint, a prior decision, and a concrete code change. No untraceable claims.
8. **Start with one mistake family.** v1 detects only premature complexity / premature optimization. If that feels sharp, expand. If not, fix it first.
9. **Optimize for interruption regret.** Track: was it dismissed? was it useful? did the user change direction? was it later proven right? Minimize regret, not maximize warnings.

## The 5 Allowed Judgment Classes

The tool is only permitted to raise issues in these categories. Anything outside this list = silence.

1. **Goal drift** — does this change move toward or away from the stated goal?
2. **Prerequisite miss** — are you doing step B before step A is validated?
3. **Architecture contradiction** — does this conflict with a prior decision or constraint?
4. **Premature optimization** — are you adding complexity before proving the bottleneck?
5. **Critical omission** — is a necessary piece missing for the chosen path?

## Trigger Events (High-Signal Only)

**Trigger on:**
- New dependency added to package.json / requirements.txt / pyproject.toml
- New service, module, or major file created
- Significant config change (infra, DB, queue, cache)
- New database, cache, or queue introduced
- Large diff touching architecture files
- User manually triggers checkpoint (`socratic.analyzeNow`)
- Milestone manually updated

**Do NOT trigger on:**
- Every file save (current v0 behavior — this must change)
- Every function edit
- CSS, text, UI tweaks
- Formatting changes
- Minor refactors

## Scoring Gate — Required Before Every Interruption

Every candidate warning must be scored across 5 dimensions. If any is weak, stay silent.

```json
{
  "event_type": "new_dependency",
  "goal_alignment": "away",
  "confidence": 0.86,
  "issue_type": "premature_optimization",
  "evidence": [
    "Goal says 'prove retrieval quality first'",
    "Diff introduces Redis caching layer",
    "No evaluation baseline exists in project memory"
  ],
  "severity": "medium",
  "actionability": "high",
  "notify": true
}
```

**Scoring dimensions:**
- **Alignment confidence** — how sure is the system the change diverges from goal?
- **Evidence strength** — can it point to something concrete in goal/diff/decisions?
- **Severity** — real mistake or stylistic alternative?
- **Novelty** — has this warning already been shown?
- **Actionability** — can it be explained in one precise sentence?

**Output policy:**
- Confidence below threshold → **silence**
- Medium confidence → **panel note only**
- High confidence + high severity + high evidence → **interrupt**

## Structured Memory (3 Objects)

Generic context dumps are useless. The tool maintains 3 small structured memory objects per workspace.

**Goal memory**
- Primary goal
- Current milestone
- Success metric
- Time horizon

**Constraint memory**
- Infra constraints (e.g., local-first, no distributed systems yet)
- Budget/scale constraints
- Timeline constraints

**Decision memory**
- Rejected options and why
- Chosen approaches
- Deferred decisions
- Prior warnings acknowledged

This is what gives the model teeth. Decision memory is where "senior-level" questions come from.

## Two-Stage Analysis Architecture

**Stage 1 — Detector**
Inputs: current goal + milestone + constraints + recent decisions + current diff summary + trigger type
Outputs: candidate issue type, confidence score, evidence array

**Stage 2 — Verifier**
Asks: Is this concrete? Is it evidenced? Is it important enough? Is it non-duplicative? Would a senior actually interrupt for this?
Only verified issues surface.

## Current Architecture (v0 — Starting Point)

```
extension.ts     → Entry point. Commands, watcher registration.
goal.ts          → Goal management. Stored in .socratic/goal.json per workspace.
watcher.ts       → Currently triggers on file save — needs to evolve to checkpoint triggers.
context.ts       → Context builder — needs to evolve into structured memory (3 objects).
llm.ts           → LLM client via OpenRouter. System prompt needs two-stage refactor.
notifications.ts → VS Code notifications. Needs 3-level output policy (silence/panel/interrupt).
```

**The v0 is a starting point, not the target architecture.** Every module will need to evolve toward the principles above. Build iteratively — don't rewrite everything at once.

## Build & Run

```bash
npm install
npm run compile        # TypeScript build
npm run watch          # Watch mode for dev
# Press F5 in VS Code to launch Extension Development Host
```

## Tech Stack

- TypeScript (strict mode), VS Code Extension API (^1.85.0)
- OpenRouter API for LLM access (default model: anthropic/claude-sonnet-4)
- No external runtime dependencies — only Node.js built-in https
- Goals and memory stored as JSON in `.socratic/` per workspace

## Code Standards

- TypeScript strict mode — no implicit any, no shortcuts
- Async/await everywhere, never callbacks
- Each file has a single responsibility with clear JSDoc header
- Architecture notes use the "ARCHITECTURE NOTE:" prefix
- Error handling: graceful degradation, never crash the extension
- Keep dependencies minimal — zero runtime npm dependencies by design

## The System Prompt Is Constrained by Design

When modifying `llm.ts`:
- Stage 1 (Detector) prompt must output structured JSON only — no free-form text
- Stage 2 (Verifier) prompt must answer binary questions — not generate new content
- The model must never be allowed to produce essays or lists of suggestions
- Test any prompt change against at least 3 scenarios: one that should interrupt, one that should be panel-only, one that should be silent

## Key Reference Documents

These files define the product's architecture and policies in detail. Read them before making significant decisions:

- **INTERRUPT_POLICY.md** — The full interrupt policy: allowed judgments, trigger events, scoring gate, output levels, two-stage engine. This is the governing spec for the analysis pipeline.
- **EXPERT_LAYER.md** — The 4-layer decision system (LLM + Project Memory + Expert Knowledge Base + Verifier), the ontology, and the v1 architecture target. This defines how expert knowledge is structured and retrieved.

## What NOT to Build (Yet)

- General architecture advice
- "What should I do next?" guidance
- Best practice suggestions
- Anything outside the 5 allowed judgment classes
- Broad monitoring of every file change

Resist feature creep. If the tool can't nail premature complexity detection first, the broader vision won't work.

## Roadmap Context

**Phase 1 (current):** Local VS Code extension. Nail premature complexity detection. Validate that interruptions feel senior-quality, not AI-fluff.

**Phase 2:** Rich sidebar with decision history. "Dismiss with reason" so the tool learns preferences. Git diff integration (commit diffs vs. milestone goals).

**Phase 3:** GitHub/GitLab PR reviewer for teams. The "methodology linter" for engineering orgs. This is where monetization lives — engineering teams, not individual devs.

## Critical Risks

1. **Noise kills retention.** One bad interruption erodes trust. Two bad ones and the extension is uninstalled. The confidence gate is not optional.
2. **Vague goals = generic useless questions.** Consider inferring goals from README, package.json, recent commits rather than relying on the developer to articulate them perfectly.
3. **Why keep it running after 3 quiet days?** Silence is correct behavior but psychologically tricky. Design a reason for presence even during quiet periods — decision log, weekly summary, etc.
4. **Phase 3 is the real product.** Individual devs are hard to monetize. Keep architecture extensible toward team/PR reviewer use cases from the start.

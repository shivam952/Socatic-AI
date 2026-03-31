# Socratic AI — V1 Technical Implementation Spec

> VS Code Extension | Solo Build | Premature Complexity Detection Only

---

## 1. What V1 Must Prove

One thing: **when the two-stage engine fires, does it feel like a senior engineer asked it?**

Not recall. Not coverage. Not feature richness. Just: when it speaks, is it right and sharp?

Success = developer catches at least one real blind spot per week, and interruption regret is low.

---

## 2. High-Level Architecture

```
[File Save Event]
      │
      ▼
[Trigger Classifier]  ──── not a decision event? ──→  SILENCE
      │
      │ decision event detected
      ▼
[Context Builder]
  - Goal Memory (.socratic/goal.json)
  - Constraint Memory (.socratic/constraints.json)
  - Decision Memory (.socratic/decisions.json)
  - Diff Summary (what changed vs. last known state)
  - Expert Rule Pack (bundled JSON)
      │
      ▼
[Stage 1: Detector LLM]
  → Outputs: CandidateIssue JSON (or null)
      │
      │ null? → SILENCE
      ▼
[Stage 2: Verifier LLM]
  → Outputs: VerifiedIssue JSON with output_level
      │
      ├── level 0 → SILENCE
      ├── level 1 → Panel/Output Channel log only
      └── level 2 → VS Code Notification (interrupt)
                          │
                          ▼
                  [Regret Tracker]
                  (log outcome per interruption)
```

---

## 3. Module Breakdown

### 3.1 `trigger.ts` — Trigger Classifier (NEW)

Replaces the current "fire on every save" behavior in `watcher.ts`.

**Responsibility:** Classify whether a file save event represents a decision-like moment.

**Trigger events to detect:**

| Event | How to detect |
|---|---|
| New dependency added | Parse package.json before/after; diff `dependencies` + `devDependencies` keys |
| New file created | Track known file set in workspace state; new path = new module |
| New service/module | New directory under `src/`, `services/`, `agents/`, `api/` etc. |
| Significant config change | Changes to `docker-compose.yml`, `.env`, `config.*`, `pyproject.toml`, `requirements.txt` |
| New DB/cache/queue introduced | Keyword scan of diff for: redis, postgres, kafka, rabbitmq, celery, mongodb, sqlite |
| Manual checkpoint | `socratic.analyzeNow` command (already exists) |

**Events to ignore:**
- CSS / styling files
- Edits to existing test files (`.test.`, `.spec.`) — but NOT creation of new test files
- Markdown / documentation
- Minor edits to existing files (< 20 lines changed, no new imports)
- Formatting-only changes

**Note on test file creation:** Creating a new test file is a signal worth classifying — specifically for Prerequisite Miss (e.g., writing tests for a module that hasn't been validated yet). However, the trigger should be narrow: only fire when the test file is for a module that is itself new or unvalidated. Track new source files in `workspaceState`; if a corresponding test file appears within the same session, classify as `new_test_for_new_module` rather than generic `new_file`.

**Output:**
```typescript
interface TriggerEvent {
  type: 'new_dependency' | 'new_file' | 'new_service' | 'config_change'
      | 'new_infra' | 'new_test_for_new_module' | 'manual_checkpoint' | 'none';
  evidence: string[];    // ALL evidence accumulated in this debounce window
  diff_summary: string;  // Short plain-English summary of what changed
  file_path: string;
}
```

**Debounce strategy — accumulate, don't replace:**
The debounce window is **15 seconds**. During this window, trigger events are **accumulated**, not overwritten. If the developer creates 3 new service directories in 15 seconds, all 3 appear in the `evidence` array when the pipeline fires. "Last event wins" loses evidence; accumulated evidence makes questions more situated.

```typescript
// In watcher.ts state:
let pendingTriggers: TriggerEvent[] = [];
let debounceTimer: NodeJS.Timeout | undefined;

// On each save:
const trigger = classifyTrigger(document, workspaceState);
if (trigger.type !== 'none') {
  pendingTriggers.push(trigger);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const batch = pendingTriggers;
    pendingTriggers = [];
    await runPipeline(mergeTriggers(batch), memory, expertRules);
  }, 15_000);
}
```

`mergeTriggers()` combines all accumulated events into a single `TriggerEvent` with a unified evidence array.

**State tracking:** Use `vscode.ExtensionContext.workspaceState` to store:
- Last known `package.json` dependency set
- Known file paths in workspace (source files and test files tracked separately)
- Timestamp of last analysis per trigger type

---

### 3.2 `memory.ts` — Structured Memory (REPLACES context.ts)

**Responsibility:** Read and write the three memory objects. Provide a single `loadMemory()` call that assembles everything the pipeline needs.

**File locations** (all in `.socratic/` per workspace root):

```
.socratic/
  goal.json          ← already exists, keep schema
  constraints.json   ← NEW
  decisions.json     ← NEW
  warnings-log.json  ← NEW (for novelty check + regret tracking)
```

**Schemas:**

```typescript
// goal.json — existing, unchanged
interface GoalMemory {
  goal: string;
  milestone: string;        // current immediate focus
  success_metric: string;   // how we know the milestone is done
  time_horizon: string;     // e.g., "2 weeks"
  setAt: string;
  context?: string;
}

// constraints.json
interface ConstraintMemory {
  constraints: string[];
  // e.g.:
  // "Local-first, no cloud infra until validated"
  // "No distributed systems before single-node proven"
  // "Keep dependencies minimal"
}

// decisions.json
interface DecisionRecord {
  id: string;               // uuid
  decision: string;         // what was decided
  rationale: string;        // why
  rejected_alternatives: string[];
  timestamp: string;
}
interface DecisionMemory {
  decisions: DecisionRecord[];
}

// warnings-log.json
interface WarningRecord {
  id: string;
  timestamp: string;
  issue_type: string;
  message: string;
  file_path: string;
  outcome: 'dismissed' | 'useful' | 'changed_direction' | 'unknown';
  // outcome filled in after user responds
}
interface WarningsLog {
  warnings: WarningRecord[];
}
```

**Commands to expose:**
- `socratic.addConstraint` — quick input box to add a constraint
- `socratic.logDecision` — manual escape hatch: structured input for decisions made outside Socratic's awareness (whiteboard, Notion, team discussions)
- `socratic.setMilestone` — update the current milestone inside goal.json

**Passive decision capture (primary path):**
When a user responds `"Changed my approach"` to a Level 2 notification, immediately prompt: *"What did you decide instead? (2 sentences)"*. Auto-write the response as a `DecisionRecord` in `decisions.json`. This is the primary capture path — it fires at the moment of decision, requires no habit, and produces the most accurate records. The manual `socratic.logDecision` command is the fallback for decisions that happened outside the extension's view.

---

### 3.3 `expert-rules/premature-complexity.json` — Expert Rule Pack (NEW)

Bundled static JSON. V1 ships with exactly one rule pack.

```json
{
  "domain": "solo-ai-fullstack-builder",
  "mistake_family": "premature_complexity",
  "description": "Detects infrastructure, tooling, or architectural complexity added before the bottleneck is proven",
  "warning_signs": [
    "Adding a message queue (Kafka, RabbitMQ, Celery) before proving async load",
    "Adding a caching layer (Redis, Memcached) before measuring what is slow",
    "Adding microservices or service splits before single-node pain exists",
    "Adding orchestration (Kubernetes, Docker Compose multi-service) before stable core logic",
    "Adding a vector DB or embedding pipeline before validating retrieval quality",
    "Adding auth/user systems before proving the core loop works",
    "Adding background workers before synchronous path is validated"
  ],
  "rubric": [
    "Is there evidence of a bottleneck that requires this component?",
    "Is the current milestone blocked without this component?",
    "Does this increase the operational/debugging surface significantly?",
    "Is a simpler alternative available that could validate the same thing?",
    "Does this contradict a prior decision or stated constraint?"
  ],
  "good_warning_examples": [
    "You added Redis caching, but your milestone is proving retrieval quality and no eval baseline exists yet. This adds infra before evidence.",
    "This introduces an async worker queue, but your goal states 'validate single-user flow first.' Async complexity may delay the validation.",
    "You added Kafka, but your constraint says 'no distributed systems before single-node pain.' What load justified this?"
  ],
  "bad_warning_examples": [
    "Consider whether this is the best approach.",
    "You might want to think about scalability.",
    "This could be improved with better architecture.",
    "Have you considered using a different pattern?"
  ]
}
```

---

### 3.4 `pipeline.ts` — Two-Stage LLM Pipeline (REPLACES llm.ts)

**Responsibility:** Run Detector → Verifier and return a routed output.

#### Stage 1: Detector

**Input:**
```typescript
interface DetectorInput {
  trigger: TriggerEvent;
  goal: GoalMemory;
  constraints: ConstraintMemory;
  decisions: DecisionMemory;
  recent_warnings: string[];   // last 5 message strings, for novelty
  expert_rules: ExpertRulePack;
}
```

**System prompt (Detector):**
```
You are a code analysis engine. Your job is to detect ONE specific class of mistake: premature complexity or premature optimization.

You will be given:
- A trigger event (what just changed and why it was flagged)
- The developer's current goal and milestone
- Their project constraints
- Their prior decisions
- Expert rules for detecting premature complexity

Your output must be a JSON object only. No prose. No explanation outside the JSON.

If you detect a potential issue, output:
{
  "issue_found": true,
  "issue_type": "premature_complexity",
  "evidence": ["<concrete fact 1>", "<concrete fact 2>", "<concrete fact 3>"],
  "alignment": "away",
  "confidence": 0.0-1.0,
  "severity": "low|medium|high",
  "one_sentence": "<The specific concern in one precise sentence>"
}

If no issue, output:
{
  "issue_found": false
}

Rules:
- Only flag premature complexity. Nothing else.
- Evidence must cite the actual diff, goal, constraint, or decision. No generic claims.
- Confidence below 0.7 = issue_found false.
- If the milestone explicitly requires this component, issue_found false.
- If a prior decision explicitly approved this component, issue_found false.
```

#### Stage 2: Verifier

**Input:** DetectorOutput + original DetectorInput

**System prompt (Verifier):**
```
You are a quality gate. A detector has proposed a warning to show a developer.

Your job: decide if this warning is worth the interruption.

Answer these questions about the proposed warning:
1. Is the evidence concrete and specific (not generic best-practice advice)?
2. Is it tied to the developer's actual goal or milestone?
3. Is it actionable — can the issue be understood in one sentence?
4. Is it non-duplicative of recent warnings?
5. Would a real senior engineer interrupt a developer for this, or let it slide?

Output JSON only:
{
  "approved": true|false,
  "output_level": 0|1|2,
  "final_message": "<The one question to show the developer. Frame as a question. 2 sentences max.>",
  "reasoning": "<Why this is or isn't worth surfacing. 1 sentence.>"
}

Output levels:
- 0: Do not surface. Low confidence, generic, or duplicative.
- 1: Log to panel only. Interesting but not interrupt-worthy.
- 2: Interrupt with notification. High confidence, concrete, important.

If approved is false, output_level must be 0.
If confidence was below 0.75, output_level should not exceed 1.
When uncertain between Level 1 and Level 2, always choose Level 1. Default to conservative. The cost of a missed warning is low; the cost of an unwarranted interruption erodes trust permanently.
```

**Output:**
```typescript
interface PipelineResult {
  output_level: 0 | 1 | 2;
  final_message: string;
  reasoning: string;
  raw_candidate: CandidateIssue | null;
  warning_id: string;  // uuid, for regret tracking
}
```

#### Error Handling Policy

All pipeline failures must be **silent to the user and logged to the output channel only**. Never crash the extension. Never surface a stale or partial warning.

| Failure | Policy |
|---|---|
| Detector returns malformed JSON | Treat as `{ "issue_found": false }`. Log to output channel. |
| Verifier returns malformed JSON | Treat as `output_level: 0`. Log to output channel. |
| OpenRouter API rate-limited (429) | Silently skip this trigger cycle. Log rate-limit hit to output channel. Do not retry automatically. |
| OpenRouter API down / timeout | Silently skip. Log error to output channel. No user-facing message. |
| `decisions.json` or `constraints.json` corrupted / unparseable | Load empty defaults (`[]`). Log parse error to output channel. Do not attempt repair. |
| `.socratic/` directory missing | Create it silently on first write. Never error on missing directory. |
| No goal set | Skip pipeline entirely. The watcher already handles this — double-check in pipeline entry point as a guard. |

**Token budget — 4,000 tokens with explicit prioritization:**
When assembling the Detector prompt, enforce this priority order if truncation is needed:
1. Goal + active milestone + success metric (never truncate)
2. Constraints (never truncate — usually small)
3. Last 5 decision records (truncate older ones first if > 5 exist)
4. Expert rule pack: rubric + warning signs only (drop examples if tight)
5. Diff summary (truncate to 500 tokens max)

Decision Memory must never be silently dropped — it is the primary source of "this contradicts your earlier decision" quality. If the full decision list exceeds budget, take the 5 most recent, not a random subset.

---

### 3.5 `notifications.ts` — Output Router (UPDATE)

Add Level 1 (panel-only) as a distinct path. Extend "Tell me more" / "Dismiss" to capture regret signal.

**Level 0:** Nothing. Return.

**Level 1:** `outputChannel.appendLine(...)` only. No popup.

**Level 2:** VS Code notification with actions:
- `"This helped"` → log outcome: `useful`
- `"Changed my approach"` → log outcome: `changed_direction`
- `"Not relevant"` → log outcome: `dismissed`

After response, write outcome back to `warnings-log.json`.

---

### 3.6 `watcher.ts` — Update

Replace the direct `analyzeCode()` call with the new pipeline:

1. On save → call `classifyTrigger()` from `trigger.ts`
2. If `trigger.type === 'none'` → return early
3. Load memory via `loadMemory()`
4. Load expert rule pack
5. Run `runPipeline(trigger, memory, expertRules)`
6. Route output via `notifications.ts`

Keep the debounce but reduce default to **10 seconds** (current 45s is too slow for feedback during dev). Make it configurable.

---

## 4. Data Flow: End-to-End Example

**Setup:**
- Goal: "Build a local-first RAG MVP and validate retrieval quality before scaling"
- Milestone: "Prove top-k hit rate on 50 test documents"
- Constraint: "No cloud infra, no distributed systems until retrieval is validated"
- Decision: "Rejected Pinecone — too early. Using local FAISS."

**Event:** Developer saves `package.json` — diff shows `"redis": "^4.6.0"` added to dependencies.

**Trigger Classifier:** detects `new_dependency`, evidence = "Added 'redis' to package.json"

**Detector input:** trigger + goal + constraint + decision memory + premature-complexity rule pack

**Detector output:**
```json
{
  "issue_found": true,
  "issue_type": "premature_complexity",
  "evidence": [
    "Goal: validate retrieval quality before scaling",
    "Milestone: prove top-k hit rate on 50 test documents — no eval baseline yet",
    "Constraint: no distributed systems until retrieval is validated",
    "Diff: added Redis dependency"
  ],
  "confidence": 0.91,
  "severity": "high",
  "one_sentence": "Redis caching was added before retrieval quality has been validated or measured."
}
```

**Verifier output:**
```json
{
  "approved": true,
  "output_level": 2,
  "final_message": "You added Redis before establishing an eval baseline — your milestone is retrieval-quality validation, not caching. What bottleneck does this solve right now?",
  "reasoning": "High confidence, evidence is concrete, ties directly to milestone, non-duplicative."
}
```

**Result:** VS Code notification fires. Developer reads it. Pauses. Removes Redis. Responds "Changed my approach" → prompted for decision → logs: "Deferring Redis until eval baseline is proven."

---

### Example 2 — Should produce Level 1 (panel only)

**Setup:**
- Goal: "Ship a working auth flow for the MVP demo"
- Milestone: "User can sign up, log in, and see their dashboard"
- Constraint: "No infra complexity — use existing Supabase"
- Decision: "Using Supabase Auth, not rolling our own"

**Event:** Developer adds `dayjs` to package.json.

**Trigger Classifier:** detects `new_dependency`, evidence = "Added 'dayjs' to package.json"

**Detector output:**
```json
{
  "issue_found": true,
  "issue_type": "premature_complexity",
  "evidence": ["Goal is auth flow", "dayjs is a date utility library"],
  "confidence": 0.42,
  "severity": "low",
  "one_sentence": "A date library was added but no date-related feature is part of the current milestone."
}
```

**Verifier output:**
```json
{
  "approved": true,
  "output_level": 1,
  "final_message": "dayjs was added but the current milestone has no date logic. Worth noting.",
  "reasoning": "Confidence too low for interruption — dayjs is a common utility, not infra complexity. Panel note only."
}
```

**Result:** Logged silently to output channel. No popup. Developer uninterrupted.

---

### Example 3 — Should produce Level 0 (silence)

**Setup:** Same as Example 1.

**Event:** Developer saves `src/retrieval/chunker.ts` — refactored the `chunkDocument()` function, no new imports, 18 lines changed.

**Trigger Classifier:** Minor edit to existing file, no new imports, < 20 lines → `type: 'none'`

**Result:** Pipeline never runs. Complete silence. Correct behavior.

---

## 5. New File Structure

```
src/
  extension.ts          ← minimal changes (new commands)
  goal.ts               ← minimal changes (add milestone/metric fields)
  memory.ts             ← NEW (replaces context.ts)
  trigger.ts            ← NEW (replaces watcher's fire-on-save logic)
  pipeline.ts           ← NEW (replaces llm.ts — two-stage detector+verifier)
  watcher.ts            ← UPDATE (use trigger.ts + pipeline.ts)
  notifications.ts      ← UPDATE (3-level output + regret capture)

expert-rules/
  premature-complexity.json   ← NEW (bundled rule pack)

.socratic/  (per workspace, gitignored)
  goal.json             ← existing
  constraints.json      ← NEW
  decisions.json        ← NEW
  warnings-log.json     ← NEW
```

---

## 6. VS Code Commands (Updated)

| Command | Description |
|---|---|
| `socratic.setGoal` | Set goal + milestone + success metric + time horizon |
| `socratic.showGoal` | Show current goal |
| `socratic.addConstraint` | Add a constraint to constraint memory |
| `socratic.logDecision` | Log a decision with rationale + rejected alternatives |
| `socratic.analyzeNow` | Manual checkpoint — force analysis on current file |
| `socratic.setApiKey` | Set OpenRouter API key |
| `socratic.showWarningsLog` | Show history of all warnings + outcomes |

---

## 7. Build Sequence (Solo)

Build in this exact order. Each step is shippable and testable before moving on.

**Step 1 — Structured Memory (2–3 days)**
- Create `memory.ts` with read/write for all 3 memory objects
- Add `constraints.json` and `decisions.json` schemas
- Add `socratic.addConstraint` and `socratic.logDecision` commands
- Extend `goal.ts` to include milestone + success_metric + time_horizon fields
- Test: manually set goal, add constraints, log decisions. Verify JSON written correctly.

**Step 2 — Trigger Classifier (2–3 days)**
- Create `trigger.ts`
- Implement package.json diff detection (store last-known deps in workspaceState)
- Implement new file detection (track known file set)
- Implement infra keyword scan on diff content
- Implement config file change detection
- Test: add a dep, create a file, change a config — verify correct TriggerEvent emitted. Save a CSS file — verify `type: 'none'`.

**Step 3 — Expert Rule Pack (1 day)**
- Create `expert-rules/premature-complexity.json` (schema above)
- Write loader in `pipeline.ts` that reads and parses it
- Test: verify rule pack loads correctly, all fields present.

**Step 4 — Two-Stage Pipeline (3–4 days)**
- Create `pipeline.ts`
- Implement Detector: assemble prompt from DetectorInput, call LLM, parse CandidateIssue JSON
- Implement Verifier: assemble prompt from CandidateIssue + context, call LLM, parse VerifiedIssue JSON
- Add error handling: malformed JSON → treat as `issue_found: false`
- Test manually with 3 scenarios:
  - HIGH signal: add Redis before eval baseline → should produce Level 2 output
  - MEDIUM signal: add a utility library → should produce Level 0 or 1
  - NO signal: edit a function body → should produce Level 0

**Step 5 — Wire It Together (1–2 days)**
- Update `watcher.ts` to use trigger.ts → pipeline.ts flow
- Update `notifications.ts` with 3-level routing + regret capture buttons
- Add warnings-log.json write-back after user response
- Test full end-to-end: trigger event → output level → regret captured

**Step 6 — Regret Review Command (1 day)**
- `socratic.showWarningsLog` command
- Display in output channel: each warning, its message, outcome, date
- Simple summary: X warnings shown, Y useful, Z dismissed

**Step 7 — Hardening (2 days)**
- Rate limiting: minimum **8-minute cooldown** between any two consecutive Level 2 interrupts. Not a per-hour cap — a cooldown. This prevents rapid-fire spam during an active session without punishing a productive architecture session where 5 legit interruptions in 2 hours is valid. Track `lastLevel2Timestamp` in extension state; if `now - lastLevel2Timestamp < 8 minutes`, downgrade to Level 1.
- Token budget: 4,000 tokens with explicit prioritization order (see Section 3.4 Error Handling Policy)
- Handle edge cases: no goal set, no API key, workspace has no `.socratic/` dir (see Error Handling Policy)
- Ensure all pipeline errors are silent — logged to output channel, never surfaced as notifications

---

## 8. What V1 Explicitly Does NOT Include

- General architecture advice
- Suggestions outside premature complexity
- Goal inference from codebase (Phase 2)
- Sidebar UI (Phase 2)
- Git integration (Phase 2)
- GitHub App / PR reviewer (Phase 3)
- Multi-model support beyond OpenRouter
- Any backend, accounts, or analytics

---

## 9. Success Criteria for V1

| Criteria | Target |
|---|---|
| Interruption regret rate | < 30% dismissed without action |
| Precision on premature complexity | ≥ 70% of Level 2 interruptions confirmed useful |
| False positive rate | < 1 Level 2 interrupt per day on normal coding |
| Silence correctness | No interruptions on CSS, docs, minor refactors |
| End-to-end latency | < 8 seconds from trigger event to notification |

---

## 10. Testing Scenarios (Manual)

Before shipping, test these exact scenarios:

**Should interrupt (Level 2):**
1. Goal: "validate RAG quality." Add `redis` to package.json → must interrupt
2. Goal: "prove single-node works." Create `services/worker-queue/` directory → must interrupt
3. Goal: "build MVP." Add `celery` + `rabbitmq` to requirements.txt → must interrupt

**Should panel-log only (Level 1):**
1. Add a well-known utility library (lodash, dayjs) with no infra implications
2. Create a new test file

**Should be silent (Level 0):**
1. Edit an existing function body (no new imports, < 20 lines changed)
2. Save a CSS file
3. Save a markdown file
4. Add a comment
5. Refactor a variable name

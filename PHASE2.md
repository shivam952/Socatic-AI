# Socratic AI — Phase 2 Plan

> "Your AI senior engineer that never lets you over-engineer."
> Target: $500K MRR in 24 months. First paying users in 90 days.

---

## The Market Position

Copilot writes code. Cursor writes code faster. Socratic AI is the only product whose job
is to slow you down at the right moment — before you add Redis you don't need, before you
build the microservice architecture for 12 users, before you optimize code that hasn't been
written yet.

**Primary buyer:** Solo founders and small teams (2–10 devs) with no senior engineer
to gut-check their architecture decisions. They feel this pain acutely. They are already
paying $15/month for Copilot without thinking twice.

**The moat:** Structured memory. Goal + milestone + constraints + decision history is a
project-specific context graph that no other tool builds. The longer a user runs Socratic,
the smarter it gets. Copilot knows nothing about your constraints. Socratic knows everything.

---

## Revenue Path

| Stage | Target | How |
|---|---|---|
| 0–6 months | $7.5K MRR | 500 paying users × $15/month |
| 6–12 months | $50K MRR | 5,000 users + team tier at $49/month |
| 12–24 months | $500K MRR | IDE-agnostic, GitHub App, enterprise |

**Pricing at launch:**
- **Free:** Unlimited warnings, 1 rule pack (premature-complexity), no team features
- **Pro:** $15/month — all rule packs, git integration, sidebar panel, warning history export
- **Team:** $49/month / 5 seats — shared constraint library, shared decision history, admin dashboard

No credit card on signup. Upgrade prompt only after the 3rd warning marked "useful."

---

## Phase 2 Build Roadmap

Three tracks. Run sequentially — parallel tracks produce unfocused product.

---

### Track 1: Intelligence (Weeks 1–6)
*Nothing else matters if the warnings aren't good.*

The current product requires manual constraint entry to fire correctly. That's a cold-start
problem that kills adoption. A user who installs Socratic and sees "lgtm" for their first
3 saves uninstalls it. Track 1 fixes this.

#### 1.1 — Goal-implied constraint inference (START HERE)
**Problem:** Without explicit constraints, the Detector defaults to "lgtm." Manual constraint
entry is too much friction for cold-start adoption.

**Solution:** After goal setup, run a second LLM call that generates candidate constraints
from the goal text alone. User picks from a list — no typing required.

**UX flow:**
```
User completes 4-question goal setup
→ "Analysing your goal for constraints..." (status bar)
→ Quick-pick appears:
    ✅ No message brokers or task queues before retrieval quality is validated
    ✅ No cloud infrastructure until core pipeline is proven
    □  No managed database before local storage is validated
    ✅ Keep dependencies minimal — add only what the current milestone requires
→ User checks/unchecks → OK
→ Accepted constraints written to constraints.json automatically
```

**Files to create/modify:**
- `src/constraints.ts` — new file: `suggestConstraints(goal)`, `promptConstraintPicker()`
- `src/goal.ts` — call `promptConstraintPicker()` at end of `promptSetGoal()`
- `src/pipeline.ts` — new function `callConstraintSuggester()` (separate LLM call, 200 tokens max)

**Spec:** See `TRACK1_1_SPEC.md` (below).

---

#### 1.2 — Three new rule packs

| Rule Pack | Fires When | Example Warning |
|---|---|---|
| `scope-creep.json` | New file/directory outside milestone scope | "You're creating `workers/` but milestone is proving retrieval quality — is that in scope?" |
| `architecture-contradiction.json` | New import contradicts established stack | "You decided on local Ollama. `openai` just appeared in requirements.txt." |
| `dependency-sprawl.json` | Dep count crosses threshold relative to project age | "20 dependencies and no validated core loop yet." |

Each rule pack is a JSON file in `src/expert-rules/` with the same schema as
`premature-complexity.json`. The pipeline loads all rule packs and runs each through
the Verifier. The highest-severity finding wins.

---

#### 1.3 — Git integration as primary trigger

File saves are noisy. Git commits are decisions.

**Implementation:**
- `Socratic: Install Git Hooks` command → writes `.git/hooks/pre-commit` shell script
- Script pipes `git diff --cached --stat` + `git diff --cached` (first 3000 chars) to a
  local HTTP endpoint the extension exposes on `localhost:27341`
- Extension receives the diff, constructs a `TriggerEvent` with real diff evidence,
  runs the pipeline immediately (no debounce — commit = decision)

This replaces the 15-second debounce with commit-time analysis. Real diff evidence
instead of "manual checkpoint on requirements.txt."

---

#### 1.4 — Decision capture from commit messages

Parse commit messages for decision language patterns:
`switched to`, `replaced`, `using X instead of Y`, `removed`, `added`, `decided`

Auto-prompt: "That commit looks like a decision — want to log it?" One click.
DecisionMemory gets populated without the user touching the command palette.

---

### Track 2: Experience (Weeks 7–12)
*Once intelligence is reliable, UX must match.*

#### 2.1 — Sidebar webview panel

Replace the output channel as the primary interface. A VS Code webview panel showing:
- Active goal + milestone (editable inline)
- Last 5 warnings with outcome icons (✅ useful / 🔄 changed / ❌ dismissed)
- Live regret rate
- Quick-add constraint button
- One-click "Log a decision" with pre-filled context from current file

This is the single biggest UX leap available. Changes the product from
"buried notification tool" to "always-visible engineering conscience."

**Tech:** `vscode.window.createWebviewPanel`, React + Tailwind bundled via esbuild.
Post messages between extension and webview for live updates.

#### 2.2 — Inline diagnostics

Use `vscode.languages.createDiagnosticCollection` to draw a yellow squiggle on the
offending line. Hovering shows the Socratic warning inline. This is the demo moment —
the warning appears IN the code, not buried in a panel.

#### 2.3 — Onboarding flow

First-time activation → guided walkthrough panel (not the command palette):
1. Set goal (inline form, not 4 separate input boxes)
2. Get suggested constraints (Track 1.1 — auto-shown)
3. Demo warning against a sample file

Time-to-first-warning target: under 3 minutes.

#### 2.4 — Warning quality feedback loop

Add "This was wrong because..." option alongside "Not useful." Free text.
Build a lightweight backend (Supabase, ~2 hours) to collect this.
It's the training data for v2 intelligence and the earliest signal on warning quality.

---

### Track 3: Distribution (Weeks 13–18)
*Don't launch until Track 1 and Track 2 are done.*

#### 3.1 — VS Code Marketplace publish
Package, sign, publish. Marketplace description leads with "AI senior engineer,"
not "developer tool." Hero screenshot: Level 2 warning, confidence 10/10, catching
a Redis addition with the rationale visible.

#### 3.2 — The demo video (most important GTM artifact)
90 seconds. Solo founder building a RAG app. Adds Redis. Socratic fires:
*"Your milestone is proving retrieval quality. Redis adds operational complexity
before you've validated the core loop."* Founder pauses. Removes Redis. Ships faster.
That video is the GTM strategy.

#### 3.3 — Launch sequence
- Week 1: r/LocalLLaMA + r/MachineLearning (the exact Agentic RAG audience)
- Week 2: Show HN — "Show HN: I built an AI that questions your architecture decisions, not writes your code"
- Week 3: Product Hunt, coordinated
- Week 4: 10 YC founders, free Pro, 15-minute feedback calls

#### 3.4 — JetBrains plugin
IntelliJ/PyCharm adds ~2x TAM. Core pipeline is IDE-agnostic (TypeScript → language server
protocol). JetBrains plugin wraps the same pipeline in Kotlin. Start after Marketplace launch.

---

## North Star Metric

**Regret rate < 20%** — less than 1 in 5 warnings is dismissed without any action.

Secondary:
- Time-to-first-warning < 3 minutes (onboarding quality)
- Day-7 retention > 40% (habit formation)
- Warning-to-upgrade conversion > 5% (monetization signal)

---

## The One Thing That Kills This

The product only works if the user sets a goal. Developers don't currently write down
goals before coding — they just code. Every second of friction between "install" and
"first useful warning" is a lost user.

**The long-term solve:** Infer the goal from the repo — README, existing comments,
git history, package.json description. User confirms rather than creates. That's v2
intelligence and it's the hardest problem. But if you solve it, the product becomes
fully passive: install it and forget it; it watches you.

That's what makes it a platform, not a tool.

---

## What To Build Now

**Track 1.1 — goal-implied constraint inference.** One new LLM call, no new
infrastructure, removes the biggest cold-start blocker immediately. See below.

---

# Track 1.1 — Concrete Implementation Spec

## Goal
After `promptSetGoal()` completes, automatically suggest 3–5 constraints derived from
the user's goal + milestone. User picks from a quick-pick list. Zero manual typing.
Accepted constraints are written directly to `constraints.json`.

## New file: `src/constraints.ts`

### Function 1: `suggestConstraints(goal, apiKey, model)`
Calls the LLM with a focused prompt. Returns `string[]` of suggested constraints.

**System prompt:**
```
You are a senior engineer doing a project intake review.
Given a developer's goal, milestone, and context, generate the top 4 architectural
constraints they should commit to for this stage of the project.

Each constraint should:
- Be concrete and actionable (something that can be violated — not vague advice)
- Be appropriate for the CURRENT MILESTONE, not the finished product
- Start with "No" or "Only" or "Must" for clarity

Respond with a JSON array of strings only. No explanation.
Example: ["No cloud infrastructure until retrieval quality is validated",
          "No message brokers before the core pipeline handles 100 requests reliably"]
```

**User prompt:** Serialised goal object (goal, milestone, success_metric, time_horizon, context)

**Token budget:** 300 max output tokens — constraint list is short.

**Error handling:** If the call fails or returns malformed JSON, return `[]` silently.
The goal setup flow must never fail because of this optional step.

### Function 2: `promptConstraintPicker(suggestions, context)`
Shows `vscode.window.showQuickPick` with the suggested constraints as checkable items.
Pre-selects all by default (user opts OUT rather than opts IN — higher acceptance rate).
Returns the accepted `string[]`.

```typescript
export async function promptConstraintPicker(
    suggestions: string[]
): Promise<string[]> {
    if (suggestions.length === 0) { return []; }

    const items = suggestions.map(s => ({
        label: s,
        picked: true,  // All pre-selected — opt-out model
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: '🧠 Socratic: Suggested constraints for your milestone',
        placeHolder: 'Uncheck any that don\'t apply. These help Socratic catch violations.',
    });

    return (picked ?? []).map(item => item.label);
}
```

### Function 3: `setupConstraintsFromGoal(goal, apiKey, model)`
Orchestrates the full flow. Called from `goal.ts` after `saveGoal()`.

```typescript
export async function setupConstraintsFromGoal(
    goal: GoalMemory,
    apiKey: string,
    model: string
): Promise<void> {
    // Show status bar while generating
    vscode.window.setStatusBarMessage('$(sync~spin) Socratic: Analysing goal for constraints...', 8000);

    const suggestions = await suggestConstraints(goal, apiKey, model);
    if (suggestions.length === 0) { return; } // Silent fail — don't block goal setup

    const accepted = await promptConstraintPicker(suggestions);
    if (accepted.length === 0) { return; }

    // Write accepted constraints to memory
    for (const c of accepted) {
        addConstraint(c);
    }

    vscode.window.showInformationMessage(
        `✅ Socratic: ${accepted.length} constraint${accepted.length > 1 ? 's' : ''} added.`
    );
}
```

## Changes to `src/goal.ts`

In `promptSetGoal()`, after `saveGoal(goalMemory)`:

```typescript
// 1.1: Auto-suggest constraints from goal — removes cold-start friction.
// Reads API key from config. If not set yet, skip silently (user can add
// constraints manually later or they'll be prompted on next goal set).
const config = vscode.workspace.getConfiguration('socratic');
const apiKey = config.get<string>('apiKey', '');
const model = config.get<string>('model', 'anthropic/claude-sonnet-4-5');
if (apiKey) {
    await setupConstraintsFromGoal(goalMemory, apiKey, model);
}
```

Import: `import { setupConstraintsFromGoal } from './constraints';`

## Build order

1. Create `src/constraints.ts` with all three functions
2. Add `setupConstraintsFromGoal` call to `promptSetGoal()` in `goal.ts`
3. `npm run compile` — zero errors
4. Test: delete `.socratic/` in Agentic RAG, reload extension, run Set Project Goal
5. After milestone step, quick-pick should appear with 4 constraint suggestions
6. Accept all, check `.socratic/constraints.json` — should have 4 entries
7. Run "Analyze Now" on requirements.txt — should fire without manual constraint entry

## Success criteria

| Test | Expected |
|---|---|
| Set goal with API key set | Quick-pick appears with ≥3 suggestions |
| All pre-selected by default | Yes — opt-out model |
| Accept all → constraints.json | 3–5 entries written |
| Accept none → constraints.json | Unchanged (no entries added) |
| API key not set | Goal saves normally, no quick-pick, no error |
| LLM call fails | Goal saves normally, no quick-pick, no error |
| Run Analyze Now after accepting constraints | Fires level 2 for celery/redis without manual input |

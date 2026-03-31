# Socratic AI: Vision & Product Strategy

> *"AI that questions your thinking, not writes your code."*

---

## 1. The Origin

Socratic AI was born from a specific, lived frustration. A developer was tasked with evaluating a RAG chatbot. They spent hours building a validation set based on 2 documents — completely missing that the production RAG indexed 10. The mistake wasn't in the code. It was a methodological blind spot. A senior engineer glancing over their shoulder would have caught it in 30 seconds.

Solo developers, juniors, and freelancers don't have that senior engineer. Socratic AI is that engineer.

---

## 2. The Contrarian Bet

The current AI landscape is obsessed with replacement. Copilot writes your code. ChatGPT answers your questions. Cursor refactors your files. They all compete on the same axis: make developers faster.

Our contrarian belief: **the industry is racing to replace human thinking, but AI is best utilized to train and sharpen it.**

When AI gives you the answer, you ship faster but understand less. You don't learn *why*. Socratic AI is built on the opposite premise — it never gives you the full plan. It waits for a high-signal moment, and then it asks the one question a senior engineer would ask.

It makes developers better, not just faster.

---

## 3. The Problem

Developers waste 30–40% of their time on predictable methodological errors:
- Going down the wrong architectural path
- Adding infrastructure before validating the bottleneck
- Missing prerequisites before building dependent systems
- Making decisions that contradict earlier constraints

Code reviews happen *after* the code is written, meaning the time is already wasted. No tool currently intervenes *during* the thinking, at the moment the mistake is being made.

---

## 4. The Solution: Rarely Speaking, But Always Right

Socratic AI is a VS Code extension that acts as a proactive senior engineer. The key promise is not "always helpful." It is **"rarely speaking, but always right."**

This is achieved not through better prompting or a bigger model, but through strict architectural discipline:

**Narrow judgment** — the tool judges only 5 classes of issues: goal drift, prerequisite miss, architecture contradiction, premature optimization, and critical omission. It does not give general advice.

**High-signal triggers** — it does not watch every keystroke. It watches for decision-like moments: a new dependency added, a new service created, a significant config change. Most saves are ignored entirely.

**Confidence-gated interruptions** — every candidate warning is scored across alignment confidence, evidence strength, severity, novelty, and actionability. If any dimension is weak, the tool stays silent. Silence is the default.

**Two-stage engine** — a Detector proposes candidate issues. A Verifier audits them: "Is this concrete? Is it evidenced? Would a real senior engineer interrupt for this?" Only verified issues surface.

**Structured memory, not raw history** — the tool maintains three small memory objects per project: Goal Memory (primary goal, milestone, success metric, horizon), Constraint Memory (infra limits, budget, timeline), and Decision Memory (what was chosen, what was rejected, and why). This is what makes a question feel situated rather than generic.

**Citeable interruptions** — every warning must trace to a goal, a constraint, a prior decision, and a concrete code change. No untraceable claims.

---

## 5. The 4-Layer Decision Architecture

Socratic AI does not rely solely on an LLM's native knowledge — that leads to generic, plausible-sounding advice that ignores the specific stage and constraints of the project. Instead, it uses a 4-layer decision system:

**Layer 1 — The LLM:** Reasoning, synthesis, and question framing. The engine, never the sole source of truth.

**Layer 2 — Project Memory:** What is true for *this* project. Goal, milestones, constraints, decision rationale.

**Layer 3 — Expert Knowledge Base:** What is true for *this class of problem*. Proven patterns and anti-patterns, stage-based heuristics (MVP vs. Scale), domain-specific tradeoffs, review rubrics, and playbooks.

**Layer 4 — The Verifier / Policy Layer:** Decides when the model must shut up. Scores output against evidence, severity, actionability, and alignment before any interruption fires.

---

## 6. The Expert Knowledge Layer

Expert knowledge is structured into three reusable artifacts — not dumped as raw text:

**Playbooks** — Small, focused guides for specific domains (e.g., "Solo AI Product Builder Playbook"). Each contains core metrics, preferred build order, and warning signs for that domain.

**Review Rubrics** — Strict checklists the LLM must evaluate before proposing an issue. Example for Premature Complexity: Is there evidence of a bottleneck? Is the component operationally expensive? Is a simpler alternative available? Is the milestone blocked without it?

**Decision Records** — The persistent memory of *why* choices were made. "Delayed event bus until single-node logic stabilizes." This is what enables: "This change conflicts with your earlier decision to postpone an event bus until single-node logic is proven."

---

## 7. Why This Is Defensible

**Low blast radius.** If a coding assistant hallucinates code, you spend hours debugging. If Socratic asks a bad question, you dismiss it in 5 seconds. The Socratic method is inherently safe, which means it can be trusted faster than code-generating tools.

**Persistent, structured context.** ChatGPT forgets your project between sessions. Socratic maintains a structured mental model of your goal, your constraints, and the decisions you've made. This accumulated Decision Memory is the moat — it gets more valuable the longer it runs.

**Proactivity.** You don't have to remember to ask it. It interrupts you when it spots danger. That's a fundamentally different product category from any chat-based tool.

**Narrowness as quality.** Most AI tools try to be as generally helpful as possible. Socratic AI tries to be precisely right about a narrow set of mistakes. Narrow scope is how quality stays high as the system scales.

---

## 8. The Metric That Matters

The north star metric is **interruption regret**: how often did the tool interrupt and the user wished it hadn't?

Not precision. Not recall. Not "bugs caught." Regret per interruption.

This is tracked by recording for each interruption: Was it dismissed? Was it useful? Did the user change direction? Was it later proven right? The goal is to minimize regret, not maximize warnings.

---

## 9. Roadmap

### Phase 1 — Local Extension (Current)
**Goal:** Validate that proactive interruptions feel senior-quality, not AI-fluff.
**Scope:** Solo builders working on AI/full-stack products.
**First mistake family:** Premature complexity / premature optimization only. If this one category can be made to feel sharp and trustworthy, the broader vision is validated.
**Success metric:** Developer catches at least one major methodological blind spot per week. Interruption regret is low.

### Phase 2 — The Thinking Partner
**Features:**
- Rich sidebar UI showing decision history and warning log
- "Dismiss with reason" — the tool learns your preferences and project constraints
- Git integration: commit diffs analyzed against milestone goals
- Playbook-based expert knowledge for specific domains

**Monetization target:** Solo freelancers, bootcamp graduates, junior/mid-level developers seeking affordable mentorship.

### Phase 3 — Team & Enterprise Scale
**Features:**
- GitHub/GitLab PR reviewer: Socratic challenges architectural choices of a PR before a human reviewer looks at it
- Team alignment: junior developers' daily code output checked against lead engineer's architectural decisions
- Shared Decision Memory across teams

**Vision:** The standard "methodology linter" for engineering teams worldwide.
**Monetization:** Engineering teams and orgs — this is where willingness to pay actually lives.

---

## 10. What the V1 Architecture Looks Like

For v1, no graph database is needed. Three simple components:

1. **Expert Rule Pack (JSON)** — A static knowledge pack for solo AI/full-stack builders. Contains principles, anti-patterns, rubrics, and ordering rules.

2. **Decision Memory Store (JSON)** — A structured local store per workspace tracking what was chosen, what was rejected, why, and when.

3. **Two-Stage LLM Pipeline:**
   - *Detector:* Takes current diff + Goal + Expert Rule Pack + Decision Memory → outputs Candidate Issue JSON
   - *Verifier:* Takes Candidate Issue → answers: concrete? evidenced? important? non-duplicate? actionable? → routes to silence, panel note, or interrupt

The graph database (with the full ontology of `Goal`, `Decision`, `Constraint`, `Evidence`, `Risk`, etc. and relations like `contradicts`, `depends_on`, `rejected_because`) becomes the moat in Phase 2+. But the ontology must be designed correctly now so it doesn't require a rewrite later.

---

## 11. Critical Open Questions

**Interruption calibration** — The confidence gate and trigger events are the solution, but they require tuning data. Build the feedback loop (regret tracking) from day one, not Phase 2.

**Goal-setting friction** — Developers are bad at articulating goals upfront. Consider inferring goals from README, package.json, recent commit messages as a fallback. Vague goal = useless questions = uninstall.

**Retention during silence** — Why keep the extension running after 3 quiet days? Silence is correct behavior but psychologically tricky. Design a presence signal for quiet periods — weekly decision log summary, milestone progress view, etc.

**Phase 3 as the real product** — Individual devs are hard to monetize. Keep the architecture extensible toward team/PR reviewer use cases from the start. Phase 1 validates the mechanism; Phase 3 validates the business.

---

## 12. Verdict

The insight is differentiated and non-obvious. The problem is real and acute. The build cost is low. The moat (structured Decision Memory + domain-specific expert knowledge) is genuine if executed well.

The risk is not competition — it's indifference. The question that must be designed into the product from day one: **why will someone keep this running after it's been quiet for 3 days?**

If that question has a good answer, this is worth building.

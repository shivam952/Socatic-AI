# Socratic AI: Interrupt Policy & Core Principles

To achieve the promise of being **"rarely speaking, but always right,"** the system must explicitly *avoid* trying to be generally smart. High quality comes from strict boundaries, not better prompting.

The system is governed by these foundational principles:
1. **Narrow in what it judges.**
2. **Strict in when it is allowed to speak.**
3. **Grounded in evidence from the project.**
4. **Scored before every interruption.**

---

## 1. Allowed Judgments (Narrow Scope)
The tool must **never** answer vague questions like "What architecture should I use?" or "Give me ideas." It is restricted to detecting five specific classes of errors:

1. **Goal Drift:** Does this change move toward or away from the stated goal?
2. **Prerequisite Miss:** Are you doing Step B before Step A is validated?
3. **Architecture Contradiction:** Does this conflict with a prior decision or constraint?
4. **Premature Optimization:** Are you adding complexity before proving the bottleneck?
5. **Critical Omission:** Is a necessary piece missing for the chosen path?

*If it keeps to these 5, quality is high. If it opines on everything, quality collapses.*

---

## 2. High-Signal Triggers (Not Every Save)
Socratic AI does **not** trigger on every `Cmd+S`. Watching everything equally creates noise. It waits for **decision-like moments**.

**Good Triggers (High Signal):**
*   New dependency added (`package.json`, `requirements.txt`).
*   New service or module created.
*   Significant config changes.
*   New database/cache/queue introduced.
*   User clicks "Analyze Checkpoint" manually.

**Ignored Events (Noise):**
*   Minor function edits or text tweaks.
*   UI/CSS refinements.
*   Formatting or tiny refactors.

---

## 3. The Scoring Gate
Every candidate warning must cross a strict scoring threshold before it is allowed to interrupt the user. 

**Warning Score = `f(Confidence, Evidence, Severity, Novelty, Actionability)`**

*   **A. Alignment Confidence:** How sure is the system that this actually deviates from the goal?
*   **B. Evidence Strength:** Can it point to something concrete? (e.g., *Goal says "low-latency MVP", diff adds Kafka + Redis instances*).
*   **C. Severity:** Is this a structural mistake, or just a stylistic alternative?
*   **D. Novelty:** Has the user already seen this warning?
*   **E. Actionability:** Can the issue be explained logically in one precise sentence?

*If any of these dimensions are weak, the system stays silent.*

---

## 4. Structured Memory (Not Dumped History)
Dumping raw chat history makes LLMs fuzzy. Socratic AI relies on small, highly specific memory objects:

1. **Goal Memory:** Primary goal, current milestone, success metric, time horizon.
2. **Constraint Memory:** e.g., "Local first", "cheap infra", "no distributed systems yet".
3. **Decision Memory:** e.g., "Rejected Pinecone because too early", "Chose local FAISS limit for MVP".

---

## 5. Output Levels & Strict Formatting
The model is **banned** from producing long, rambling natural-language essays. It must output a strict internal JSON structure first:

```json
{
  "event_type": "new_dependency",
  "goal_alignment": "away",
  "confidence": 0.86,
  "issue_type": "premature_optimization",
  "evidence": [
    "Goal says 'prove retrieval quality first'",
    "Diff introduces Redis caching layer",
    "No eval baseline exists in project memory"
  ],
  "severity": "medium",
  "actionability": "high",
  "notify": true
}
```

Based on the `notify` flag and confidence score, the output is routed to one of three levels:
*   **Level 0 (Silence):** No issue or low confidence. Most outputs should die here.
*   **Level 1 (Panel Note):** Interesting, but not worth a popup. Logged to the sidebar.
*   **Level 2 (Interrupt):** High-confidence, concrete, important. Shows a VS Code notification.

---

## 6. The Two-Stage Engine (The Architecture)
Do not let one model pass decide to speak. 

*   **Stage 1 (Detector):** Looks at the diff + memory + goal and proposes candidate issues.
*   **Stage 2 (Verifier):** Audits the detector. *Is this concrete? Is it evidenced? Is it a duplicate? Would a real senior interrupt for this, or just let it slide?*

Only verified issues surface. This single architectural choice dramatically reduces hallucination and noise.

---

## 7. The V1 Target
To ensure the system works, V1 will focus on a hyper-narrow domain:
**Solo builders designing AI/full-stack products.**

And it will specifically listen for just ONE class of mistake:
**Premature Complexity / Premature Optimization.**
*(e.g., Adding queues before load, adding microservices before proving single-node pain, adding caching before eval).*

**The Metric:** Minimum regret per interruption.
How often did the tool interrupt, and the user wish it hadn't? Optimize strictly to lower this number.

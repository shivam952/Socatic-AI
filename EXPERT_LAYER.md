# Socratic AI: The Expert Knowledge Layer

Relying solely on an LLM's native knowledge is a critical failure point. It leads to generic, plausible-sounding advice that ignores the specific stage, constraints, and domain of the project.

Socratic AI does not use a massive, unstructured "knowledge graph" or raw document retrieval. It uses a **decision-quality knowledge system** composed of four explicit layers.

---

## 1. The 4-Layer Decision System

### Layer 1: The LLM
**Role:** Reasoning, language synthesis, and question framing.
**Status:** It is the engine, **never** the sole source of truth.

### Layer 2: Project Memory
**Role:** Grounding the model in what is true **for this project**.
**Contents:**
*   **Goal:** The primary objective and time horizon.
*   **Milestones:** The current immediate focus.
*   **Constraints:** "Local first", "Cheap infra", "No distributed systems".
*   **Decisions:** Prior rationale (e.g., "Rejected Pinecone because too early").

### Layer 3: Expert Knowledge Base
**Role:** Grounding the model in what is true **for this class of problem**.
**Contents:**
*   Proven patterns and anti-patterns.
*   Architecture checklists and stage-based heuristics (MVP vs. Scale).
*   Domain-specific tradeoffs.

### Layer 4: The Verifier / Policy Layer
**Role:** Deciding when the model must **shut up**.
**Contents:**
*   Scores the output against evidence, severity, actionability, and alignment.

---

## 2. Structured Expert Knowledge (Not Random Blogs)

Expert knowledge must be structured into reusable artifacts, not dumped as raw text. 

### A. Playbooks (Domain-Specific Guides)
Small, focused JSON/YAML guides for specific domains (e.g., "AI Agent Product Playbook").
Each playbook contains:
*   **Core Metrics:** What actually matters for this domain.
*   **Preferred Build Order:** e.g., Eval pipeline *before* UI polish.
*   **Warning Signs:** e.g., High token usage without caching.

### B. Review Rubrics (The Scoring Gates)
Strict checklists the LLM must evaluate before proposing an issue.
*Example: Premature Complexity Rubric*
1.  Is there evidence of a bottleneck?
2.  Is the added component operationally expensive?
3.  Does it increase the debugging surface?
4.  Is the current milestone blocked without it?
5.  Is a simpler alternative available?

### C. Decision Records (Project Gold)
The persistent memory of *why* choices were made.
*Example:* "Delayed event bus until single-node logic stabilizes."
*Resulting Output:* "This change conflicts with your earlier decision to postpone an event bus until single-node logic is proven."

---

## 3. The Pre-Graph Ontology

Before building a complex Graph Database (Neo4j, etc.), the system relies on a strict ontology defining the relationships between core entities.

**Entities:**
`Goal`, `Milestone`, `Constraint`, `Decision`, `Alternative`, `Task`, `ArchitectureComponent`, `Risk`, `Warning`, `Evidence`, `Metric`, `TriggerEvent`.

**Relations:**
`supports`, `contradicts`, `depends_on`, `postponed_until`, `chosen_because`, `rejected_because`, `increases_complexity_of`, `required_for`.

*A graph becomes the moat later, allowing the tool to trace rationale chains and contradictions across large projects. But the ontology must come first.*

---

## 4. The V1 Architecture Target

For V1, the system does **not** need a giant graph database. It needs:

### 1. The Expert Rule Pack (JSON)
A static knowledge pack for **one domain** (e.g., Solo builders building AI products), containing principles, anti-patterns, rubrics, and ordering rules.

### 2. The Decision Memory Store (JSON)
A structured local store tracking what was chosen, what was rejected, why, and when.

### 3. The LLM Reasoner Pipeline
Takes the current diff + Goal + Expert Rule Pack + Decision Memory -> Outputs Candidate Issue.
Passes Candidate Issue through Verifier -> Interrupts or stays silent.

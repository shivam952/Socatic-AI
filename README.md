# Socratic AI

**The PR reviewer that never forgets what you're building.**

Most PR reviews check if the code works. Socratic checks if the code is what you said you'd build — catching scope creep, constraint violations, and goal drift before they merge.

---

## GitHub Action — 2-minute setup

Add this to any repo and every PR gets a goal-aware review:

```yaml
# .github/workflows/socratic-review.yml
name: Socratic Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  socratic-review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: shivam952/Socatic-AI@main
        with:
          api-key: ${{ secrets.SOCRATIC_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

That's it. Socratic reads `.socratic/goal.json` and `.socratic/constraints.json` from your repo and posts a structured review on every PR.

---

## What a review looks like

```
🧠 Socratic AI Review — 🔴 Needs Discussion

> This PR adds Redis caching and a Celery task queue. Your current milestone
> is document ingestion quality — no async infrastructure is needed yet.

📍 Reviewing against: Complete document ingestion pipeline

### 🔴 Critical

⛔ Constraint Violation
- ⚠️ Redis and Celery added before retrieval quality validated
- ✦ Your constraint: "No Redis/Celery until >80% retrieval accuracy achieved"

📈 Scope Creep
- ⚠️ Background task queue adds operational complexity not needed for milestone 1
- ✦ Prove the synchronous pipeline works first — async can come in milestone 2

### 🟡 Medium

🏗 Architecture
- ⚠️ build_app() called on every request — rebuilds the entire graph per call
- ✦ Build once at module load and reuse the compiled instance
```

---

## Setup: Define your goal and constraints

Socratic needs two files committed to your repo (one-time setup):

**`.socratic/goal.json`**
```json
{
  "goal": "Build a document Q&A system for internal knowledge bases",
  "milestone": "Working retrieval pipeline with >80% accuracy on test queries",
  "success_metric": ">80% accuracy on 50-question eval set",
  "time_horizon": "3 weeks"
}
```

**`.socratic/constraints.json`**
```json
[
  "No external APIs until local models proven insufficient",
  "No Redis or queuing until synchronous pipeline is validated",
  "Keep dependencies under 10 for milestone 1"
]
```

Commit these files, add the workflow, and every PR gets reviewed against them.

> **Using the VS Code extension?** Run `Socratic: Set Project Goal` and `Socratic: Add Constraint` — they write these files automatically.

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | ✅ | — | OpenRouter API key (store as `SOCRATIC_API_KEY` secret) |
| `model` | | `anthropic/claude-sonnet-4` | LLM model via [OpenRouter](https://openrouter.ai) |
| `fail-on-critical` | | `false` | Set `true` to block merges on critical issues or constraint violations |

---

## Block merges on constraint violations

```yaml
- uses: shivam952/Socatic-AI@main
  with:
    api-key: ${{ secrets.SOCRATIC_API_KEY }}
    fail-on-critical: 'true'
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## VS Code Extension

The companion tool for working inside your codebase:

- **Goal inference** — reads your codebase on first open and suggests a goal + constraints
- **Deep Review** — multi-file analysis at onboarding, each milestone update, and pre-ship
- **Save watcher** — flags scope creep and constraint violations as you code
- **Pre-ship gatekeeper** — Go/No-Go verdict when you tag a release or push to main
- **Health trajectory** — diffs the last 5 reviews to show if technical debt is improving

---

## Privacy

- No backend. No telemetry. No data collection.
- All project state lives in `.socratic/` inside your repo.
- LLM calls go through your own OpenRouter account — you control the model and billing.
- The GitHub Action runs entirely in your CI environment.

---

## License

MIT — free for open source. See [pricing](https://socratic.dev) for private repos.

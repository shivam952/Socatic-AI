# Socratic AI — Test Guide (Agentic RAG Project)

This guide walks through a complete end-to-end test of Socratic AI on the Agentic RAG project, covering all three tracks.

---

## Step 0 — Install the Extension

1. Open VS Code
2. Open the Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Click the `…` menu → **Install from VSIX…**
4. Select `socratic-ai-0.1.0.vsix` from the `COVE/socratic-ai/` folder
5. Reload VS Code when prompted

---

## Step 1 — Set Your API Key

Run from the Command Palette (`Cmd+Shift+P`):

```
Socratic: Set API Key
```

Paste your OpenRouter API key. The key is stored in VS Code's secret storage (never written to disk).

> The default model is `anthropic/claude-sonnet-4`. You can change it in Settings → Socratic AI → Model.

---

## Step 2 — Open the Agentic RAG Project

Open the `Agentic RAG/` folder in VS Code (`File → Open Folder`).

The extension activates on startup. Within a few seconds you should see the **status bar** update at the bottom of VS Code with a daily focus message like:

```
⚡ 12 days left | 0 open critical issues
```

---

## Step 3 — Onboarding Deep Review

The extension reads `.socratic/goal.json` on startup. Since the goal is already set, it will trigger an **onboarding deep review** automatically after activation.

You'll see a spinner in the status bar: `🔍 Socratic: reviewing…`

After 15–30 seconds, a VS Code notification will appear. Open it to see the full report. You can also run it manually:

```
Socratic: Deep Review
```

### What to expect

The deep review should surface the following findings:

| Severity | Finding | File |
|----------|---------|------|
| 🔴 Critical | Heavy infra in requirements (Redis, Celery, Kafka, Airflow) at milestone 1 | `requirements.txt` |
| 🔴 Critical | Web search fallback active before retrieval quality measured | `rag/graph.py` |
| 🔴 Critical | `build_app()` called on every `chat()` request | `rag/graph.py:287` |
| 🟠 High | `_SESSIONS` dict unbounded — memory leak | `rag/graph.py:284` |
| 🟠 High | `result["answer"]` unguarded — crashes on None | `rag/graph.py:307` |
| 🟡 Medium | No evaluation harness for the >80% accuracy metric | `tests/` |
| 🟡 Medium | `load_config()` has no error handling | `rag/graph.py:16`, `rag/indexer.py:22` |

The constraint violations (C1, C2) should be flagged with the specific constraint text from `.socratic/constraints.json`.

---

## Step 4 — View the Warnings Log

```
Socratic: Show Warnings Log
```

This opens a JSON panel showing all findings with timestamps, severity levels, and whether they've been resolved.

---

## Step 5 — Update the Milestone

After you've fixed the critical issues, run:

```
Socratic: Update Milestone
```

Enter something like: `"Fix critical runtime issues in graph.py and validate local retrieval before enabling web search fallback"`

This triggers a **milestone deep review** — a new focused pass that compares your current code against the updated milestone and checks if the critical findings were resolved.

---

## Step 6 — Install Git Hooks

```
Socratic: Install Git Hooks
```

Now every `git commit` in the Agentic RAG project will trigger a lightweight Socratic analysis of the changed files. You'll see a VS Code notification within a few seconds of each commit.

---

## Step 7 — Pre-Ship Review (Trigger Test)

The pre-ship review fires automatically on:
- Creating a git tag (`git tag v0.1.0`)
- Merging to `main`/`master`
- Bumping version in `package.json` (or `pyproject.toml` in future)

To test it manually:
```
Socratic: Pre-Ship Review
```

This runs a Go/No-Go verdict on the current state of the project. Since the critical issues haven't been fixed yet, it should return a **No-Go** with specific blockers listed.

---

## Step 8 — Health Trajectory

After you've run at least two deep reviews (onboarding + milestone), run:

```
Socratic: Show Health Trajectory
```

This shows a diff between the last 5 reviews: how many findings were resolved, how many are new, and the overall trend direction (↘ improving / ↗ worsening / → stable).

---

## Step 9 — Analyze Now (Quick Check)

At any point, trigger an immediate lightweight analysis of the currently open file:

```
Socratic: Analyze Now
```

---

## What Good Looks Like

After the test is complete you should have verified:

- [ ] Onboarding deep review fires on startup and surfaces real findings
- [ ] Constraint violations are called out explicitly with the constraint text
- [ ] `build_app()` per-request anti-pattern is caught
- [ ] `_SESSIONS` memory leak is caught
- [ ] Level 2 notification appears for critical findings (info panel, not just a toast)
- [ ] Warnings log is populated
- [ ] Milestone update triggers a new review
- [ ] Git hook fires on commit
- [ ] Pre-Ship Review returns a No-Go with blockers
- [ ] Health Trajectory shows the delta after fixes

---

## Troubleshooting

**Status bar shows nothing** — check that the API key is set (`Socratic: Set API Key`) and that `socratic.enabled` is `true` in settings.

**Deep review times out** — the default model is `claude-sonnet-4` via OpenRouter. If you hit rate limits, switch to a smaller model in settings: `openai/gpt-4o-mini`.

**Git hooks not firing** — run `Socratic: Install Git Hooks` inside the Agentic RAG project folder (not the socratic-ai folder). Check that `.git/hooks/post-commit` exists and is executable.

**"No goal set" message** — the `.socratic/goal.json` already exists in the Agentic RAG project, so this shouldn't happen. If it does, run `Socratic: Set Project Goal`.

# CodePolice — Hackathon Pitch

> **"Your IDE knows what you changed. CodePolice knows why it matters."**

---

## The Problem

Every collaborative dev team faces the same invisible tax:

- A developer is assigned **Task A** (fix the login bug).
- They open their editor, get distracted, and start tweaking the recommendation engine.
- Nobody notices — not during coding, not during PR review.
- The commit lands. The login bug is still open. The recommendation engine is subtly broken. The sprint is a mess.

**Existing tools catch bugs. Nobody catches intent drift.**

Code review catches syntax. CI/CD catches regressions. Neither catches *"this developer spent 4 hours working on the wrong thing."*

---

## What CodePolice Does

CodePolice is a **real-time task-alignment engine** that lives inside VS Code and watches your code changes against your assigned task — continuously, semantically, and without interrupting your flow.

### The Loop

```
You save a file
      ↓
CodePolice diffs it (git diff or line-diff fallback)
      ↓
Node server writes it to the database instantly
      ↓
LLM (Ollama, local) summarises the change in background
      ↓
Multi-dimensional alignment rubric scores it:
  • Objective Match        (does this relate to the task?)
  • Changed Surface        (are the right files being touched?)
  • Implementation Intent  (is the approach aligned?)
  • Contradiction Penalty  (is this actively undoing the task?)
      ↓
Calibrated alignment score stored + indexed in FAISS
      ↓
Status bar turns ✅ / ⚠️ / ❌ — no manual review needed
```

All of this happens in **< 3 seconds** from keystroke to status bar update.

---

## Technical Architecture

```
┌─────────────────────────────────────────┐
│              VS Code Extension           │
│  EventListener → ChangeBuffer           │
│  → DiffExtractor → BatchProcessor       │
│  → Sidebar (alignment state + Sync Now) │
└────────────────────┬────────────────────┘
                     │ POST /describe (instant)
┌────────────────────▼────────────────────┐
│          Node.js Express Server          │
│  Fast-path: writes DB in ~10ms           │
│  Background: Ollama LLM → score update   │
│  Endpoints: /describe /progress          │
│             /retrieval /flush /search    │
└────────┬───────────────────┬────────────┘
         │                   │
┌────────▼───────┐   ┌───────▼───────────┐
│   Supabase DB   │   │   FAISS Service   │
│  file_changes   │   │  Python + FastAPI  │
│  change_descs   │   │  qwen3-embedding   │
│  align_snapshot │   │  semantic search   │
│  ugie_ app data │   └───────────────────┘
└────────────────┘
```

**Stack:** TypeScript · Node.js · Python · FastAPI · Supabase (PostgreSQL) · Ollama (local LLM) · FAISS

---

## What Makes It Unique (Our USP)

### 1. Intent-Aware, Not Just Change-Aware
Most tools track *what* changed. CodePolice tracks *why* the change exists — and whether that "why" matches your task. The LLM rubric evaluates semantic intent, not just file paths.

### 2. Zero-Latency DB Writes, Async Intelligence
The fast-path architecture decouples database writes from LLM processing. File changes hit Supabase in **~10ms**. The alignment score follows asynchronously. The developer never waits.

### 3. Local-First AI, Privacy-Safe
LLM analysis runs via **Ollama on the developer's own machine** — no source code ever leaves the local environment. The server only receives diffs (not full file contents). Teams own their data entirely.

### 4. Collaborative + Multi-Developer Ready
Every change is tagged with `github_user`. The schema includes full cross-linking to the application's user/repo/task tables (`ugie_` tables), so you can answer: *"Who was working on what task, what did they actually change, and were they on track?"* — across a whole team.

### 5. Live Dashboard Push
A `DASHBOARD_WEBHOOK_URL` configuration pushes every processed change event (with person, task, score, summary) to any external dashboard, Slack bot, or project management tool — in real time.

### 6. Semantic Search Over Your Work History
The FAISS-backed `/search` endpoint lets you ask *"when did we last change authentication logic?"* and get semantically matching change summaries — not grep results.

---

## Alignment Score — How It Actually Works

Most "AI code review" tools assign a single vague score. Ours is a calibrated rubric:

| Dimension | Weight | What it measures |
|---|---|---|
| `objective_match` | 45% | Does the change address what the task asks for? |
| `changed_surface_relevance` | 30% | Are the right files / modules being modified? |
| `implementation_intent` | 25% | Is the approach correct for the task? |
| `contradiction_penalty` | −35% | Is the change actively working against the task? |

The rubric score blends 70% with the model's direct `on_task_score` (30%), then confidence-calibrates toward neutral (0.5) when the model is uncertain. The result: **a score you can trust.**

---

## What Gets Stored

```sql
file_changes          -- every diff, instantly
change_descriptions   -- LLM summary + classification + score
alignment_snapshots   -- per-change rubric breakdown
chunks                -- time-windowed groups for embedding
```

All rows carry `github_user`, `workspace_path`, and `github_identity_id` for full attribution and cross-team analytics.

---

## Demo Scenario

> A developer is assigned: *"Fix the broken checkout flow — users can't complete payment when address validation fails."*

They open VS Code. CodePolice starts watching.

1. They edit `checkoutController.ts` → ✅ Aligned (score: 0.91)
2. They fix `addressValidator.ts` → ✅ Aligned (score: 0.87)
3. They get distracted, start editing `recommendationEngine.ts` → ❌ Off-Task (score: 0.21)
4. Status bar turns red. Sidebar shows: *"Your recent changes don't match your active task."*
5. The developer catches themselves before committing 45 minutes of off-task work.
6. On the team dashboard: a timeline shows exactly when drift started, which files were touched, and what the LLM thought they were doing.

**That's CodePolice.**

---

## The Bigger Picture

This isn't just a developer tool — it's an **intent layer for software engineering**.

- **Project managers** get real-time visibility into whether the sprint is on track.
- **Tech leads** can quantify drift across the whole team before standup.
- **Developers** get a low-friction nudge, not a heavyweight process.
- **AI systems** (agents, copilots) can use the alignment signal to know when to intervene.

As AI-generated code becomes more common, the question *"is this agent doing the right thing?"* becomes critical infrastructure. CodePolice is the answer.

---

## Built By

**Arya Sentry** — `aryasentry`

Built for hackathon. All services run locally. No cloud dependency required except Supabase (can be self-hosted).

---

## Quick Start

```bash
# Extension
npm install && npm run compile
# Press F5 in VS Code

# Server
cd server && npm install && npm run dev

# FAISS service
cd faiss-service && pip install -r requirements.txt && uvicorn main:app --port 3142
```

Set your task via `Ctrl+Shift+P → CodePolice: Select Active Task`. Watch the status bar. Ship with confidence.

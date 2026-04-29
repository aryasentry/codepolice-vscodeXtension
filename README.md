# 🚔 CodePolice

> **Pre-commit task alignment engine** — detects semantic drift before you commit.

CodePolice is a VS Code extension that watches your code changes in real-time, compares them against your active task description, and warns you when you're drifting off-task.

---

## Architecture (from `plan.md`)

```
VS Code Events
      ↓
Change Buffer  (deduplicated Set)
      ↓
Debounced Batch Processor  (30s inactivity trigger)
      ↓
Diff Extraction  (git diff HEAD → fallback line diff)
      ↓
[Phase 3] Local LLM Summarization  (Ollama)
      ↓
[Phase 4] Embedding Generation + Cosine Similarity
      ↓
Alignment Score + Drift Detection
      ↓
Status Bar Indicator + Notifications
```

---

## Getting Started (Dev Mode)

### Prerequisites
- Node.js ≥ 18
- VS Code

### Run in 3 steps

```bash
# 1. Install dependencies
npm install

# 2. Compile TypeScript
npm run compile

# 3. Press F5 in VS Code  ← opens Extension Development Host
```

**That's it.** A new VS Code window opens with CodePolice loaded.

---

## Commands (Ctrl+Shift+P)

| Command | Description |
|---|---|
| `CodePolice: Select Active Task` | Set your current task ID + description |
| `CodePolice: Switch Task` | Change to a different task |
| `CodePolice: View Alignment Report` | See tracked files and change summaries |
| `CodePolice: Pause Tracking` | Temporarily stop watching |
| `CodePolice: Resume Tracking` | Resume watching |

---

## Status Bar

The status bar item (bottom-left) shows your current alignment state:

| Icon | State | Meaning |
|---|---|---|
| 🛡 | Idle | Watching, no task or no changes yet |
| ⟳ | Processing | Analysing recent saves |
| ✅ | Aligned | Changes match your active task |
| ⚠️ | Mild Drift | Slight mismatch — review your changes |
| ❌ | Off-Task | Significant drift detected |
| ⏸ | Paused | Tracking paused |

Click the status bar to open the Alignment Report.

---

## Configuration (`settings.json`)

```json
{
  "codepolice.debounceSeconds": 30,
  "codepolice.excludedDirs": ["node_modules", "dist", "build", ".git", "coverage", "out"],
  "codepolice.alignedThreshold": 0.75,
  "codepolice.mildDriftThreshold": 0.5,
  "codepolice.ollamaUrl": "http://localhost:11434",
  "codepolice.summaryModel": "codellama",
  "codepolice.embeddingModel": "nomic-embed-text"
}
```

---

## Development Phases

| Phase | Status | Description |
|---|---|---|
| 1 — Extension Skeleton | ✅ **Done** | Events, buffer, debounce, diff, snapshot store, status bar, commands |
| 2 — Diff + Snapshot | ✅ **Done** | Hash comparison, git diff, fallback diff, metadata storage |
| 3 — LLM Integration | 🔜 Next | Ollama summarization + embedding generation |
| 4 — Alignment Engine | 🔜 | Cosine similarity + drift scoring |
| 5 — UI Layer | 🔜 | Richer report view, notifications |

---

## Project Structure

```
CodePolice/
├── src/
│   ├── extension.ts        # Entry point — wires all modules
│   ├── eventListener.ts    # VS Code event subscriptions
│   ├── changeBuffer.ts     # Deduplicated file change queue
│   ├── batchProcessor.ts   # Debounced orchestrator
│   ├── diffExtractor.ts    # git diff + fallback line diff
│   ├── snapshotStore.ts    # Persistent state (hashes, task, embeddings)
│   ├── statusBar.ts        # Status bar UI manager
│   └── commands.ts         # All registered commands
├── resources/
│   └── icon.png
├── .vscode/
│   ├── launch.json         # F5 = Run Extension
│   └── tasks.json          # npm watch as default build task
├── package.json
├── tsconfig.json
└── plan.md
```

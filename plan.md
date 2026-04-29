Task-Aligned Development VS Code Extension
1. Vision

Build a VS Code extension that:

Tracks meaningful local code changes

Understands what changed (not just that something changed)

Compares current development activity with the assigned task

Detects semantic drift before commit

Provides real-time alignment feedback

Operates efficiently without scanning the entire codebase

The extension acts as a pre-commit task alignment engine.

2. Core Principles

Event-driven, not polling-based

Incremental diff tracking, not full repo scanning

Local-first processing

No raw code stored permanently

Lightweight and non-intrusive

Scales with changed files, not project size

3. High-Level Architecture
VS Code Events
      ↓
Change Buffer (Deduplicated Queue)
      ↓
Debounced Batch Processor
      ↓
Diff Extraction
      ↓
Local LLM Summarization
      ↓
Embedding Generation
      ↓
Task Similarity Engine
      ↓
Alignment Score + Drift Detection
      ↓
Status Indicator + Notifications
4. System Modules
4.1 Event Listener Module
Responsibilities

Subscribe to workspace events:

onDidSaveTextDocument

onDidCreateFiles

onDidDeleteFiles

onDidRenameFiles

Behavior

On save:

Capture file path

Ignore excluded directories:

node_modules/

dist/

build/

.git/

coverage/

Add file to change buffer

No heavy processing here.

4.2 Change Buffer Module

Maintains a deduplicated set of changed files.

Data structure:

Set<string> changedFiles

On save:

Add file to set

Reset debounce timer

Purpose:
Prevent processing the same file multiple times during rapid edits.

4.3 Debounced Batch Processor

Triggered after X seconds of inactivity (e.g., 30 seconds).

Steps

Freeze buffer

For each file:

Compute content hash

Compare with stored hash

Skip if unchanged

Extract diff

Generate change summary

Update snapshot store

Clear buffer

4.4 Snapshot Store

Maintains lightweight per-file state.

Example structure:

{
  "files": {
    "auth.ts": {
      "lastHash": "abc123",
      "lastProcessedAt": "timestamp",
      "changeCount": 5
    }
  },
  "activeTaskId": "TASK-12",
  "taskEmbedding": [...],
  "recentChangeEmbeddings": [...]
}

Rules:

Never store entire file history permanently

Only store hash + metadata

Maintain limited change embedding history

4.5 Diff Extraction Strategy
Preferred Method (Git Present)

Run:

git diff HEAD -- filePath

Benefits:

Fast

Accurate

Handles renames

Handles large files efficiently

Fallback (No Git)

Store previous file content

Compare against new content

Use line-based diff library

Generate structured diff

If diff is large:

Chunk into sections

Summarize in parts

Merge summaries

4.6 Change Summarization

Uses local model via:

Ollama

Input:

Diff output

Output:

Natural language summary

Change classification:

Feature

Refactor

Bugfix

Test

Config

Documentation

Example summary:

"Added JWT validation middleware and integrated with login route."

No full file sent to model.
Only diff.

4.7 Embedding Engine

Generates vector embeddings for:

Active task description

Aggregated change summaries

Stores:

Task embedding

Rolling change embedding

Limited history of recent change embeddings

Embedding is local.

4.8 Task Alignment Engine
4.8.1 Task Selection

User selects active task via:

Command Palette

Task dropdown

Task description is embedded and stored.

4.8.2 Similarity Computation

Compute cosine similarity:

TaskEmbedding vs RollingChangeEmbedding

4.8.3 Drift Detection Logic

If similarity:

0.75 → Aligned
0.5 – 0.75 → Mild Drift
< 0.5 → Significant Drift

(Thresholds adjustable)

Drift is calculated periodically, not per keystroke.

4.9 Rolling Aggregation Strategy

Instead of comparing each diff individually:

Maintain rolling summary:

Combine recent change summaries

Recompute aggregated embedding

Weight recent changes higher

Example:

Recent 5 changes weighted more than older ones.

4.10 UI Components
Status Bar Indicator

Displays:

Alignment Score

Task Name

Drift Level

Notifications

Non-blocking alerts:

“Current edits may not align with assigned task.”

Commands

Select Active Task

Switch Task

View Alignment Report

Pause Tracking

Resume Tracking

5. Performance Design

To ensure scalability:

No periodic repo scanning

Only process saved files

Deduplicated buffer

Debounced processing

Hash-based change detection

Ignore excluded folders

Limit embedding history

Chunk large diffs

Time complexity:
O(number_of_changed_files)
Not O(total_files)

6. Edge Case Handling
6.1 Branch Switch

Detect via Git:

Temporarily pause drift detection

Reset baseline snapshot

6.2 Large Refactor

If many files change:

Process in batches

Temporarily reduce alignment weight

6.3 Mass File Creation

Ignore:

Auto-generated files

node_modules

build artifacts

6.4 Rebase / Reset

If Git history shifts:

Refresh snapshot baseline

Recompute task alignment from recent changes only

7. Privacy & Security

No raw code stored long-term

No full project scan

Embeddings generated locally

User can disable extension anytime

No keystroke tracking

8. MVP Scope

Must Include:

Save-based tracking

Diff extraction

Change summarization

Task embedding

Cosine similarity

Status bar alignment indicator

Optional (Future):

AST-level diff

Blocker detection (churn analysis)

Integration risk detection

Team analytics

Cross-file dependency graph

9. Development Phases
Phase 1 – Extension Skeleton

Create extension scaffold

Implement event listeners

Implement buffer + debounce

Phase 2 – Diff + Snapshot

Implement hash comparison

Implement Git diff fallback

Store metadata

Phase 3 – LLM Integration

Integrate with Ollama

Implement summarization

Implement embedding generation

Phase 4 – Alignment Engine

Implement cosine similarity

Add drift logic

Add rolling aggregation

Phase 5 – UI Layer

Status bar

Commands

Notification system
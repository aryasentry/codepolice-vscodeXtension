import * as vscode from 'vscode';

export interface FileSnapshot {
    lastHash: string;
    lastProcessedAt: string;
    changeCount: number;
    lastDiff?: string;
    lastContent?: string;
}

export interface StoreState {
    files: Record<string, FileSnapshot>;
    activeTaskId: string | null;
    activeTaskDescription: string | null;
    taskEmbedding: number[] | null;
    recentChangeSummaries: string[];
    recentChangeEmbeddings: number[][];
    isPaused: boolean;
}

const STORE_KEY = 'codepolice.state';
const MAX_RECENT_SUMMARIES = 10;
const MAX_RECENT_EMBEDDINGS = 10;

/**
 * Persists lightweight per-file state and task metadata to VS Code's
 * extension storage (workspaceState). Never stores raw file history.
 */
export class SnapshotStore {
    private state: StoreState;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.state = context.workspaceState.get<StoreState>(STORE_KEY) ?? this.defaultState();
    }

    // ─── File snapshots ────────────────────────────────────────────────────────

    getFileSnapshot(filePath: string): FileSnapshot | undefined {
        return this.state.files[filePath];
    }

    updateFileSnapshot(filePath: string, snapshot: FileSnapshot): void {
        this.state.files[filePath] = snapshot;
        this.persist();
    }

    // ─── Task management ──────────────────────────────────────────────────────

    setActiveTask(taskId: string, description: string): void {
        this.state.activeTaskId = taskId;
        this.state.activeTaskDescription = description;
        this.state.taskEmbedding = null; // will be computed in Phase 3
        this.state.recentChangeSummaries = [];
        this.state.recentChangeEmbeddings = [];
        this.persist();
    }

    getActiveTask(): { id: string; description: string } | null {
        if (!this.state.activeTaskId || !this.state.activeTaskDescription) {
            return null;
        }
        return {
            id: this.state.activeTaskId,
            description: this.state.activeTaskDescription,
        };
    }

    setTaskEmbedding(embedding: number[]): void {
        this.state.taskEmbedding = embedding;
        this.persist();
    }

    getTaskEmbedding(): number[] | null {
        return this.state.taskEmbedding;
    }

    // ─── Rolling change summaries ─────────────────────────────────────────────

    appendChangeSummaries(summaries: string[]): void {
        this.state.recentChangeSummaries = [
            ...summaries,
            ...this.state.recentChangeSummaries,
        ].slice(0, MAX_RECENT_SUMMARIES);
        this.persist();
    }

    getRecentChangeSummaries(): string[] {
        return this.state.recentChangeSummaries;
    }

    appendChangeEmbeddings(embeddings: number[][]): void {
        this.state.recentChangeEmbeddings = [
            ...embeddings,
            ...this.state.recentChangeEmbeddings,
        ].slice(0, MAX_RECENT_EMBEDDINGS);
        this.persist();
    }

    getRecentChangeEmbeddings(): number[][] {
        return this.state.recentChangeEmbeddings;
    }

    // ─── Misc ─────────────────────────────────────────────────────────────────

    getFullState(): StoreState {
        return { ...this.state };
    }

    resetFileSnapshots(): void {
        this.state.files = {};
        this.persist();
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    private persist(): void {
        this.context.workspaceState.update(STORE_KEY, this.state);
    }

    private defaultState(): StoreState {
        return {
            files: {},
            activeTaskId: null,
            activeTaskDescription: null,
            taskEmbedding: null,
            recentChangeSummaries: [],
            recentChangeEmbeddings: [],
            isPaused: false,
        };
    }
}

import * as vscode from 'vscode';
import { SnapshotStore } from './snapshotStore';
import { StatusBarManager } from './statusBar';
import { DebouncedBatchProcessor } from './batchProcessor';
import { SidebarProvider } from './sidebarProvider';

/**
 * Registers all CodePolice VS Code commands.
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    snapshotStore: SnapshotStore,
    statusBar: StatusBarManager,
    batchProcessor: DebouncedBatchProcessor,
    sidebar: SidebarProvider
): void {

    // ── Select / Switch Task ──────────────────────────────────────────────────
    const selectTask = vscode.commands.registerCommand(
        'codepolice.selectTask',
        () => showTaskPicker(snapshotStore, statusBar, sidebar)
    );

    const switchTask = vscode.commands.registerCommand(
        'codepolice.switchTask',
        () => showTaskPicker(snapshotStore, statusBar, sidebar)
    );

    // ── View Alignment Report ─────────────────────────────────────────────────
    const viewReport = vscode.commands.registerCommand(
        'codepolice.viewReport',
        () => showAlignmentReport(snapshotStore)
    );

    // ── Pause / Resume ────────────────────────────────────────────────────────
    const pauseTracking = vscode.commands.registerCommand(
        'codepolice.pauseTracking',
        () => {
            batchProcessor.pause();
            sidebar.refresh('paused');
            vscode.window.showInformationMessage('🚔 CodePolice: Tracking paused.');
        }
    );

    const resumeTracking = vscode.commands.registerCommand(
        'codepolice.resumeTracking',
        () => {
            batchProcessor.resume();
            sidebar.refresh(snapshotStore.getActiveTask() ? 'idle' : 'no-task');
            vscode.window.showInformationMessage('🚔 CodePolice: Tracking resumed.');
        }
    );

    context.subscriptions.push(selectTask, switchTask, viewReport, pauseTracking, resumeTracking);
}

// ─── Task Picker ──────────────────────────────────────────────────────────────

async function showTaskPicker(
    snapshotStore: SnapshotStore,
    statusBar: StatusBarManager,
    sidebar: SidebarProvider
): Promise<void> {
    const taskId = await vscode.window.showInputBox({
        title: '🚔 CodePolice — Set Active Task',
        prompt: 'Enter a task ID (e.g. TASK-42, JIRA-123)',
        placeHolder: 'TASK-42',
        ignoreFocusOut: true,
    });

    if (!taskId) return;

    const description = await vscode.window.showInputBox({
        title: `🚔 CodePolice — Describe Task ${taskId}`,
        prompt: 'Briefly describe what this task involves (used for alignment comparison)',
        placeHolder: 'Add JWT authentication middleware and integrate with the login route',
        ignoreFocusOut: true,
    });

    if (!description) return;

    snapshotStore.setActiveTask(taskId, description);
    statusBar.setTask(taskId);
    statusBar.update('idle');
    sidebar.refresh('idle');

    vscode.window.showInformationMessage(
        `🚔 CodePolice: Active task set to "${taskId}". Tracking alignment…`
    );
}

// ─── Alignment Report ─────────────────────────────────────────────────────────

async function showAlignmentReport(snapshotStore: SnapshotStore): Promise<void> {
    const state = snapshotStore.getFullState();
    const task = snapshotStore.getActiveTask();

    const lines: string[] = [
        '# 🚔 CodePolice — Alignment Report',
        '',
        task
            ? `**Active Task:** \`${task.id}\` — ${task.description}`
            : '**Active Task:** _None selected_',
        '',
        '## Recent Change Summaries',
        '',
    ];

    if (state.recentChangeSummaries.length === 0) {
        lines.push('_No changes processed yet._');
    } else {
        for (const s of state.recentChangeSummaries) {
            lines.push(`- ${s}`);
        }
    }

    lines.push('', '## Tracked Files', '');

    const fileEntries = Object.entries(state.files);
    if (fileEntries.length === 0) {
        lines.push('_No files tracked yet._');
    } else {
        for (const [file, snap] of fileEntries) {
            lines.push(`- **${file}** — ${snap.changeCount} change(s), last at ${snap.lastProcessedAt}`);
        }
    }

    lines.push(
        '',
        '---',
        '_Alignment engine (Phase 4) will add cosine similarity scores here._'
    );

    const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
    });

    await vscode.window.showTextDocument(doc, { preview: true });
}

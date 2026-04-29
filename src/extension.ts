import * as vscode from 'vscode';
import { ChangeBuffer } from './changeBuffer';
import { DebouncedBatchProcessor } from './batchProcessor';
import { SnapshotStore } from './snapshotStore';
import { StatusBarManager } from './statusBar';
import { registerCommands } from './commands';
import { EventListener } from './eventListener';
import { SidebarProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('CodePolice is now active 🚔');

    // ── Core modules ──────────────────────────────────────────────────────────
    const snapshotStore = new SnapshotStore(context);
    const statusBar = new StatusBarManager(context);
    const changeBuffer = new ChangeBuffer();
    const batchProcessor = new DebouncedBatchProcessor(
        changeBuffer,
        snapshotStore,
        statusBar,
        context
    );

    // ── Sidebar ───────────────────────────────────────────────────────────────
    const sidebarProvider = new SidebarProvider(
        context.extensionUri,
        snapshotStore,
        statusBar,
        batchProcessor,
        context
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'codepolice.sidebarView',
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Wire sidebar refresh into batch processor
    batchProcessor.onStateChange((state, score) => {
        sidebarProvider.refresh(state, score);
    });

    // ── Event listener ────────────────────────────────────────────────────────
    const eventListener = new EventListener(changeBuffer, batchProcessor, context);

    // ── Commands ───────────────────────────────────────────────────────────────
    registerCommands(context, snapshotStore, statusBar, batchProcessor, sidebarProvider);

    // ── Refresh sidebar command ───────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codepolice.refreshSidebar', () => {
            sidebarProvider.refresh();
        })
    );

    // ── Start ─────────────────────────────────────────────────────────────────
    eventListener.register();
    statusBar.update(snapshotStore.getActiveTask() ? 'idle' : 'no-task');

    vscode.window.showInformationMessage(
        '🚔 CodePolice is active — open the sidebar to get started.'
    );
}

export function deactivate() {
    console.log('CodePolice deactivated.');
}

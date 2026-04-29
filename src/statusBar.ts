import * as vscode from 'vscode';

export type AlignmentState = 'idle' | 'processing' | 'aligned' | 'mild-drift' | 'drift' | 'paused' | 'no-task';

interface StatusBarConfig {
    text: string;
    tooltip: string;
    color?: vscode.ThemeColor;
    backgroundColor?: vscode.ThemeColor;
}

const STATE_CONFIG: Record<AlignmentState, StatusBarConfig> = {
    idle: {
        text: '$(shield) CodePolice',
        tooltip: 'CodePolice: Watching for changes…',
    },
    processing: {
        text: '$(sync~spin) CodePolice: Processing…',
        tooltip: 'CodePolice: Analysing recent changes…',
    },
    aligned: {
        text: '$(pass-filled) CodePolice: Aligned',
        tooltip: 'CodePolice: Your changes align with the active task. Keep it up!',
        color: new vscode.ThemeColor('statusBarItem.prominentForeground'),
    },
    'mild-drift': {
        text: '$(warning) CodePolice: Mild Drift',
        tooltip: 'CodePolice: Slight drift detected — review your changes against the task.',
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
    },
    drift: {
        text: '$(error) CodePolice: Off-Task',
        tooltip: 'CodePolice: Significant drift detected! Changes may not relate to the active task.',
        backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    },
    paused: {
        text: '$(debug-pause) CodePolice: Paused',
        tooltip: 'CodePolice: Tracking is paused. Run "Resume Tracking" to continue.',
    },
    'no-task': {
        text: '$(shield) CodePolice: No Task',
        tooltip: 'CodePolice: No active task selected. Run "Select Active Task" to begin.',
    },
};

/**
 * Manages the VS Code status bar item for CodePolice.
 */
export class StatusBarManager {
    private readonly item: vscode.StatusBarItem;
    private currentTask: string | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.item.command = 'codepolice.viewReport';
        this.item.show();
        context.subscriptions.push(this.item);
    }

    update(state: AlignmentState, score?: number): void {
        const cfg = STATE_CONFIG[state];
        let text = cfg.text;

        if (score !== undefined && (state === 'aligned' || state === 'mild-drift' || state === 'drift')) {
            text += ` (${Math.round(score * 100)}%)`;
        }

        if (this.currentTask && state !== 'paused' && state !== 'no-task') {
            text += ` — ${this.truncate(this.currentTask, 20)}`;
        }

        this.item.text = text;
        this.item.tooltip = cfg.tooltip;
        this.item.color = cfg.color;
        this.item.backgroundColor = cfg.backgroundColor;
    }

    setTask(taskName: string): void {
        this.currentTask = taskName;
    }

    clearTask(): void {
        this.currentTask = null;
        this.update('no-task');
    }

    private truncate(str: string, max: number): string {
        return str.length > max ? str.slice(0, max) + '…' : str;
    }
}

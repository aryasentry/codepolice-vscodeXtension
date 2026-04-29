/**
 * Maintains a deduplicated set of changed file paths.
 * Prevents processing the same file multiple times during rapid edits.
 */
export class ChangeBuffer {
    private readonly files: Set<string> = new Set();

    add(filePath: string): void {
        this.files.add(filePath);
    }

    remove(filePath: string): void {
        this.files.delete(filePath);
    }

    /** Freeze the current set and clear the buffer atomically. */
    drain(): string[] {
        const snapshot = [...this.files];
        this.files.clear();
        return snapshot;
    }

    get size(): number {
        return this.files.size;
    }

    isEmpty(): boolean {
        return this.files.size === 0;
    }
}

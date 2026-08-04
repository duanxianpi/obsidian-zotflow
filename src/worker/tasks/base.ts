import { v4 as uuidv4 } from "uuid";
import type { ITaskInfo, ITaskResult, TaskStatus, TaskType } from "types/tasks";
import type { LogLevel } from "services/log-service";
import type { IParentProxy } from "bridge/types";

/** Abstract base for all trackable background tasks (sync, download, batch ops). */
export abstract class BaseTask {
    public readonly id: string;
    public readonly type: TaskType;
    public readonly createdTime: number;
    protected parentHost: IParentProxy;

    protected status: TaskStatus = "pending";
    protected progress = { completed: 0, total: 0, message: "Pending..." };
    protected result?: ITaskResult;
    protected error?: string;
    /** Human-readable title for display in Activity Center */
    protected displayText: string;
    /** Captured input context for display in expanded details */
    protected taskInput?: Record<string, string | number>;

    protected startTime?: number;
    protected endTime?: number;

    // Use a simpler approach for events to avoid complex EventEmitter in worker
    public onUpdate?: (info: ITaskInfo) => void;

    public log(
        level: LogLevel,
        message: string,
        context?: string,
        details?: unknown,
    ) {
        this.parentHost?.log(level, message, context, details);
    }

    constructor(type: TaskType, parentHost: IParentProxy, id?: string) {
        this.id = id || uuidv4();
        this.type = type;
        this.createdTime = Date.now();
        this.displayText = type; // Default, overridden by subclasses
        this.parentHost = parentHost;
    }

    public async execute(signal: AbortSignal): Promise<void> {
        this.status = "running";
        this.startTime = Date.now();
        this.emitUpdate();

        try {
            if (signal.aborted) throw new Error("Aborted");
            await this.run(signal);
            this.status = "completed";
            this.progress.completed = this.progress.total;
            this.progress.message = "Completed";
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (signal.aborted || msg === "Aborted") {
                this.status = "cancelled";
                this.progress.message = "Cancelled";
            } else {
                this.status = "failed";
                this.error = msg;
                this.progress.message = `Failed: ${msg}`;
            }
        } finally {
            this.endTime = Date.now();
            this.displayText = this.getTerminalDisplayText(this.status);
            this.emitUpdate();
        }
    }

    protected abstract run(signal: AbortSignal): Promise<void>;

    /**
     * Build a display text string for a terminal state (completed / failed / cancelled).
     * Subclasses should override to include result counts or context.
     * The base implementation appends the status to the current displayText.
     */
    protected getTerminalDisplayText(status: TaskStatus): string {
        if (status === "completed") return `${this.displayText} — Done`;
        if (status === "cancelled") return `${this.displayText} — Cancelled`;
        return `${this.displayText} — Failed`;
    }

    protected reportProgress(
        completed: number,
        total: number,
        message: string,
    ) {
        this.progress = { completed, total, message };
        this.emitUpdate();
    }

    private emitUpdate() {
        if (this.onUpdate) {
            this.onUpdate(this.getInfo());
        }
    }

    public getInfo(): ITaskInfo {
        return {
            id: this.id,
            type: this.type,
            status: this.status,
            displayText: this.displayText,
            progress: this.progress,
            result: this.result,
            input: this.taskInput,
            createdTime: this.createdTime,
            startTime: this.startTime,
            endTime: this.endTime,
            error: this.error,
            canCancel: this.status === "pending" || this.status === "running",
        };
    }
}

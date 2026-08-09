import { App } from "obsidian";
import { EventBus } from "services/event-bus";
import type { ITaskInfo } from "types/tasks";

type TaskUpdateCallback = (tasks: ITaskInfo[]) => void;

/** Pub/sub hub that tracks worker task state and notifies UI subscribers on updates. */
export class TaskMonitor {
    private tasks: Map<string, ITaskInfo> = new Map();
    private subscribers: Set<TaskUpdateCallback> = new Set();
    private syncDataRevision = 0;

    /** Fires when an annotation is created/updated/deleted (from editor or reader). */
    public readonly annotationChanged = new EventBus<
        [libraryID: number, annotationKey: string, parentItemKey: string]
    >();

    /** Fires when a LOCAL attachment's annotation is edited from the source-note editable region. */
    public readonly localAnnotationChanged = new EventBus<
        [attachmentPath: string, annotationId: string]
    >();

    /** Fires when a child note is created or updated from the source-note editable region. */
    public readonly noteChangedByEditor = new EventBus<
        [libraryID: number, noteKey: string, parentItemKey: string]
    >();

    /** Fires when a child note is created or updated from the standalone NotePreviewView. */
    public readonly noteChangedByNoteView = new EventBus<
        [libraryID: number, noteKey: string, parentItemKey: string]
    >();

    /** Fires when the tree data should be refreshed (e.g. item deleted). */
    public readonly treeChanged = new EventBus<[]>();

    constructor(private app: App) {}

    /**
     * Called by ParentHost when a task updates in the worker
     */
    public onTaskUpdate(taskId: string, info: ITaskInfo) {
        const previous = this.tasks.get(taskId);
        this.tasks.set(taskId, info);
        if (
            info.type === "sync" &&
            info.status !== "pending" &&
            info.status !== "running" &&
            previous?.status !== info.status
        ) {
            this.syncDataRevision += 1;
        }
        this.notifySubscribers();

        // Cleanup completed/failed tasks after delay (optional, handled by UI mostly)
    }

    public getTasks(): ITaskInfo[] {
        return Array.from(this.tasks.values()).sort(
            (a, b) => b.createdTime - a.createdTime,
        );
    }

    /** Revision incremented whenever a sync reaches a terminal state. */
    public getSyncDataRevision(): number {
        return this.syncDataRevision;
    }

    public subscribe(callback: TaskUpdateCallback): () => void {
        this.subscribers.add(callback);
        // Initial call
        callback(this.getTasks());

        return () => {
            this.subscribers.delete(callback);
        };
    }

    private notifySubscribers() {
        const list = this.getTasks();
        this.subscribers.forEach((cb) => cb(list));
    }
}

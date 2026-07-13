/** Lifecycle state of a background task. */
export type TaskStatus =
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

/** Identifier for the kind of background task. */
export type TaskType =
    | "sync"
    | "batch-create-notes"
    | "batch-update-notes"
    | "batch-extract-images"
    | "batch-extract-external-annotations"
    | "download-attachment"
    | "backfill-csljson"
    | "test-task";

/** Progress snapshot for a running task. */
export interface ITaskProgress {
    completed: number;
    total: number;
    message: string;
}

/** Final outcome of a completed task. */
export interface ITaskResult {
    successCount: number;
    failCount: number;
    // Structured details for display in the Activity Center (e.g. { items: 50, updated: 3 })
    details?: Record<string, string | number>;
}

/** Full task descriptor shown in the Activity Center. */
export interface ITaskInfo {
    id: string;
    type: TaskType;
    status: TaskStatus;
    // Human-readable title shown in both active and history views
    displayText: string;
    progress: ITaskProgress;
    result?: ITaskResult;
    // Captured input context for display in expanded details
    input?: Record<string, string | number>;
    createdTime: number;
    startTime?: number;
    endTime?: number;
    error?: string;
    canCancel: boolean;
}

/** Options for creating a new task. */
export interface ITaskOptions {
    id?: string; // Optional custom ID
    signal?: AbortSignal;
}

import React, { useEffect, useState, useCallback } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type { ITaskInfo, TaskType } from "types/tasks";

const TASK_TYPE_ICONS: Record<TaskType, string> = {
    sync: "refresh-cw",
    "batch-create-notes": "file-plus",
    "batch-update-notes": "file-edit",
    "batch-extract-images": "image",
    "batch-extract-external-annotations": "scan-search",
    "download-attachment": "download",
    "backfill-csljson": "book-marked",
    "test-task": "flask-conical",
};

function formatDuration(start?: number, end?: number): string {
    if (!start) return "";
    const elapsed = (end ?? Date.now()) - start;
    if (elapsed < 1000) return `${elapsed}ms`;
    if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`;
    return `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s`;
}

function formatTime(ts?: number): string {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

/** Build a JSON-style detail string from a record */
function formatDetailsJson(
    details?: Record<string, string | number>,
): string | null {
    if (!details || Object.keys(details).length === 0) return null;
    return JSON.stringify(details);
}

/* ================================================================ */
/*  Active Task Card (expandable)                                   */
/* ================================================================ */

const ActiveTaskCard: React.FC<{
    task: ITaskInfo;
    expanded: boolean;
    onToggle: () => void;
}> = ({ task, expanded, onToggle }) => {
    const icon = TASK_TYPE_ICONS[task.type] ?? "list";
    const isIndeterminate =
        task.status === "running" && task.progress.total <= 1;
    const progressPercent =
        task.progress.total > 0
            ? Math.round((task.progress.completed / task.progress.total) * 100)
            : 0;

    const handleCancel = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            workerBridge.cancelTask(task.id);
        },
        [task.id],
    );

    const inputJson = formatDetailsJson(task.input);

    return (
        <div
            className={`zotflow-task-card ${expanded ? "is-expanded" : ""}`}
            onClick={onToggle}
        >
            <div className="zotflow-task-card-row">
                <div className="zotflow-task-card-icon">
                    <ObsidianIcon
                        icon={icon}
                        className={isIndeterminate ? "zotflow-spinning" : ""}
                    />
                </div>
                <div className="zotflow-task-card-body">
                    <div className="zotflow-task-card-title">
                        {`${task.displayText} (${task.progress.message && task.progress.message})`}
                    </div>
                    {task.status === "running" && (
                        <div
                            className={`zotflow-task-progress-bar ${isIndeterminate ? "is-indeterminate" : ""}`}
                        >
                            <div
                                className="zotflow-task-progress-fill"
                                style={
                                    isIndeterminate
                                        ? undefined
                                        : { width: `${progressPercent}%` }
                                }
                            />
                        </div>
                    )}
                </div>
                {task.canCancel && (
                    <button
                        className="zotflow-task-card-cancel clickable-icon"
                        onClick={handleCancel}
                        aria-label="Cancel task"
                    >
                        <ObsidianIcon icon="x" />
                    </button>
                )}
            </div>
            {expanded && (
                <div className="zotflow-task-card-details">
                    {task.startTime && (
                        <div className="zotflow-task-detail-row">
                            <span className="zotflow-task-detail-label">
                                Elapsed
                            </span>
                            <span>{formatDuration(task.startTime)}</span>
                        </div>
                    )}
                    {inputJson && (
                        <div className="zotflow-task-detail-row">
                            <span className="zotflow-task-detail-label">
                                Input
                            </span>
                            <code>{inputJson}</code>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/* ================================================================ */
/*  History Item                                                    */
/* ================================================================ */

const HistoryItem: React.FC<{
    task: ITaskInfo;
    expanded: boolean;
    onToggle: () => void;
}> = ({ task, expanded, onToggle }) => {
    const statusIcon =
        task.status === "completed"
            ? "check-circle"
            : task.status === "failed"
              ? "x-circle"
              : "ban";

    const statusClass =
        task.status === "completed"
            ? task.result && task.result.failCount > 0
                ? "zotflow-status-warning"
                : "zotflow-status-success"
            : task.status === "failed"
              ? "zotflow-status-error"
              : "zotflow-status-muted";

    // Use warning icon for partial failures
    const displayIcon =
        task.status === "completed" && task.result && task.result.failCount > 0
            ? "alert-triangle"
            : statusIcon;

    const message = task.displayText;
    const resultJson = formatDetailsJson(task.result?.details);
    const inputJson = formatDetailsJson(task.input);

    return (
        <div
            className={`zotflow-history-item ${expanded ? "is-expanded" : ""}`}
            onClick={onToggle}
        >
            <div className="zotflow-history-header">
                <span className={`zotflow-history-status ${statusClass}`}>
                    <ObsidianIcon icon={displayIcon} />
                </span>
                <span className="zotflow-history-time">
                    {formatTime(task.endTime)}
                </span>
                <span className="zotflow-history-msg">{message}</span>
            </div>
            {expanded && (
                <div className="zotflow-history-details">
                    {inputJson && (
                        <div className="zotflow-task-detail-row">
                            <span className="zotflow-task-detail-label">
                                Input:
                            </span>{" "}
                            <div className="zotflow-history-json zotflow-history-json-input">
                                <code>{inputJson}</code>
                            </div>
                        </div>
                    )}
                    {resultJson && (
                        <div className="zotflow-task-detail-row">
                            <span className="zotflow-task-detail-label">
                                Result:
                            </span>{" "}
                            <div className="zotflow-history-json">
                                <code>{resultJson}</code>
                            </div>
                        </div>
                    )}
                    {task.error && task.status === "failed" && (
                        <div className="zotflow-task-detail-row">
                            <span className="zotflow-task-detail-label">
                                Error:
                            </span>{" "}
                            <div className="zotflow-history-json zotflow-history-json-error">
                                <code>
                                    {formatDetailsJson(task.error as any)}
                                </code>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/* ================================================================ */
/*  Tasks View                                                      */
/* ================================================================ */

/** React component displaying active background tasks and session task history. */
export const TasksView: React.FC = () => {
    const [tasks, setTasks] = useState<ITaskInfo[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    useEffect(() => {
        const unsubscribe = services.taskMonitor.subscribe(setTasks);
        return unsubscribe;
    }, []);

    const activeTasks = tasks.filter(
        (t) => t.status === "running" || t.status === "pending",
    );
    const historyTasks = tasks.filter(
        (t) =>
            t.status === "completed" ||
            t.status === "failed" ||
            t.status === "cancelled",
    );

    return (
        <div className="zotflow-tasks-view">
            {/* Active Process */}
            <div className="zotflow-tasks-section">
                <span className="zotflow-tasks-section-header">
                    Active Tasks
                </span>
                {activeTasks.length === 0 ? (
                    <div className="zotflow-tasks-empty">
                        <ObsidianIcon
                            icon="check-circle"
                            iconStyle={{ color: "var(--text-faint)" }}
                        />
                        <span>All systems go. No active tasks.</span>
                    </div>
                ) : (
                    <div className="zotflow-task-cards">
                        {activeTasks.map((task) => (
                            <ActiveTaskCard
                                key={task.id}
                                task={task}
                                expanded={expandedId === task.id}
                                onToggle={() =>
                                    setExpandedId(
                                        expandedId === task.id ? null : task.id,
                                    )
                                }
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Session History */}
            <div className="zotflow-tasks-section zotflow-tasks-history-section">
                <span className="zotflow-tasks-section-header">
                    Tasks History
                </span>
                {historyTasks.length === 0 ? (
                    <div className="zotflow-tasks-empty">
                        <ObsidianIcon
                            icon="clock"
                            iconStyle={{ color: "var(--text-faint)" }}
                        />
                        <span>No completed tasks yet</span>
                    </div>
                ) : (
                    <div className="zotflow-history-list">
                        {historyTasks.map((task) => (
                            <HistoryItem
                                key={task.id}
                                task={task}
                                expanded={expandedId === task.id}
                                onToggle={() =>
                                    setExpandedId(
                                        expandedId === task.id ? null : task.id,
                                    )
                                }
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

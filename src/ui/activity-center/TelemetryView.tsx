import React, { useState, useEffect, useCallback, useRef } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { services } from "services/services";

import type { LogLevel, LogEntry } from "services/log-service";
import { fireAndForgetIn } from "utils/fire-and-forget";

const ff = fireAndForgetIn("TelemetryView");

type LogFilter = "all" | LogLevel;

function getLogLevelClass(level: LogLevel): string {
    switch (level) {
        case "error":
            return "zotflow-log-error";
        case "warn":
            return "zotflow-log-warn";
        case "debug":
            return "zotflow-log-debug";
        case "info":
        default:
            return "";
    }
}

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

function formatEntryText(entry: LogEntry): string {
    let text = `[${formatTimestamp(entry.timestamp)}] [${entry.level.toUpperCase()}]`;
    if (entry.context) text += ` [${entry.context}]`;
    text += ` ${entry.message}`;
    if (entry.error) {
        text += `\n${formatErrorDetail(entry.error)}`;
    }
    return text;
}

function formatErrorDetail(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`;
    }
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error);
    }
}

const LogLine: React.FC<{ entry: LogEntry }> = ({ entry }) => {
    const [expanded, setExpanded] = useState(false);
    const hasDetail = !!entry.error;
    const expandable = hasDetail;

    const handleCopyEntry = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            // Notify only once the write resolves — it used to claim
            // success before knowing whether it had happened.
            ff(
                navigator.clipboard
                    .writeText(formatEntryText(entry))
                    .then(() =>
                        services.notificationService.notify(
                            "success",
                            "Log entry copied",
                        ),
                    ),
                "Failed to copy the log entry",
            );
        },
        [entry],
    );

    return (
        <div
            className={`zotflow-log-line ${getLogLevelClass(entry.level)}${expanded ? " zotflow-log-line--expanded" : ""}${expandable ? " zotflow-log-line--expandable" : ""}`}
            onClick={expandable ? () => setExpanded((v) => !v) : undefined}
        >
            <div className="zotflow-log-line-header">
                {expandable && (
                    <span className="zotflow-log-chevron">
                        <ObsidianIcon
                            icon={expanded ? "chevron-down" : "chevron-right"}
                        />
                    </span>
                )}
                <span className="zotflow-log-time">
                    {formatTimestamp(entry.timestamp)}
                </span>
                <span className="zotflow-log-level">
                    {entry.level.toUpperCase()}
                </span>
                {entry.context && (
                    <span className="zotflow-log-context">
                        [{entry.context}]
                    </span>
                )}
                <span className={"zotflow-log-msg zotflow-log-msg--truncated"}>
                    {entry.message}
                </span>
                <button
                    className="zotflow-log-copy-btn clickable-icon"
                    onClick={handleCopyEntry}
                    aria-label="Copy log entry"
                >
                    <ObsidianIcon icon="copy" />
                </button>
            </div>
            {expanded && hasDetail && (
                <pre className="zotflow-log-detail">
                    {formatErrorDetail(entry.error)}
                </pre>
            )}
        </div>
    );
};

export const TelemetryView: React.FC = () => {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<LogFilter>("all");
    const [search, setSearch] = useState("");
    const consoleRef = useRef<HTMLDivElement>(null);

    // Poll logs from LogService (it's an in-memory buffer, no pub/sub)
    useEffect(() => {
        const refresh = () => {
            setLogs([...services.logService.logs]);
        };
        refresh();
        const interval = setInterval(refresh, 1_000);
        return () => clearInterval(interval);
    }, []);

    const filteredLogs = logs.filter((entry) => {
        const matchesFilter = filter === "all" || entry.level === filter;
        if (!matchesFilter) return false;

        if (search) {
            const q = search.toLowerCase();
            const inMessage = entry.message.toLowerCase().includes(q);
            const inContext = entry.context?.toLowerCase().includes(q) ?? false;
            return inMessage || inContext;
        }
        return true;
    });

    const handleCopy = useCallback(() => {
        const text = filteredLogs.map((e) => formatEntryText(e)).join("\n");
        ff(
            navigator.clipboard
                .writeText(text)
                .then(() =>
                    services.notificationService.notify(
                        "success",
                        "Logs copied to clipboard",
                    ),
                ),
            "Failed to copy the logs",
        );
    }, [filteredLogs]);

    const handleClear = useCallback(() => {
        services.logService.clearLogs();
        setLogs([]);
    }, []);

    return (
        <div className="zotflow-telemetry-view">
            <div className="zotflow-telemetry-toolbar">
                <select
                    className="dropdown zotflow-telemetry-filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as LogFilter)}
                >
                    <option value="all">All</option>
                    <option value="info">Info</option>
                    <option value="warn">Warn</option>
                    <option value="error">Error</option>
                    <option value="debug">Debug</option>
                </select>
                <input
                    type="text"
                    className="zotflow-telemetry-search"
                    placeholder="Search logs..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button
                    className="zotflow-telemetry-toolbar-btn clickable-icon"
                    onClick={handleCopy}
                    aria-label="Copy all logs"
                >
                    <ObsidianIcon icon="copy" />
                </button>
                <button
                    className="zotflow-telemetry-toolbar-btn clickable-icon"
                    onClick={handleClear}
                    aria-label="Clear logs"
                >
                    <ObsidianIcon icon="trash-2" />
                </button>
            </div>
            <div className="zotflow-log-console" ref={consoleRef}>
                {filteredLogs.length === 0 ? (
                    <div className="zotflow-log-empty">
                        No logs match current filters.
                    </div>
                ) : (
                    filteredLogs.map((entry) => (
                        <LogLine key={entry.id} entry={entry} />
                    ))
                )}
            </div>
        </div>
    );
};

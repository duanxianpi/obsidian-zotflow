/** Log severity level. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Shape of a single in-memory log record. */
export interface LogEntry {
    id: string;
    timestamp: number;
    level: LogLevel;
    message: string;
    context?: string;
    error?: unknown;
}

/** In-memory ring-buffer logger (max 1 000 entries). */
export class LogService {
    private _logs: LogEntry[] = [];
    private readonly MAX_LOGS = 1000;

    public get logs() {
        return this._logs;
    }

    public debug(message: string, context?: string, details?: unknown) {
        const prefix = this.getPrefix(context);
        const args: unknown[] = [prefix, message];
        if (details) args.push(details);

        // console.debug(...args);

        this.addEntry("debug", message, context, details);
    }

    public info(message: string, context?: string, details?: unknown) {
        const prefix = this.getPrefix(context);
        const args: unknown[] = [prefix, message];
        if (details) args.push(details);

        // console.log(...args);

        this.addEntry("info", message, context, details);
    }

    public warn(message: string, context?: string, details?: unknown) {
        const prefix = this.getPrefix(context);
        const args: unknown[] = [prefix, message];
        if (details) args.push(details);

        // console.warn(...args);

        this.addEntry("warn", message, context, details);
    }

    public error(message: string, context?: string, error?: unknown) {
        const prefix = this.getPrefix(context);
        const args: unknown[] = [prefix, message];
        if (error) args.push(error);

        console.error(...args);

        this.addEntry("error", message, context, error);
    }

    public log(
        level: LogLevel,
        message: string,
        context?: string,
        details?: unknown,
    ) {
        switch (level) {
            case "debug":
                this.debug(message, context, details);
                break;
            case "info":
                this.info(message, context, details);
                break;
            case "warn":
                this.warn(message, context, details);
                break;
            case "error":
                this.error(message, context, details);
                break;
        }
    }

    public clearLogs() {
        this._logs = [];
    }

    private getPrefix(context?: string) {
        return `[ZotFlow${context ? `:${context}` : ""}]`;
    }

    private addEntry(
        level: LogLevel,
        message: string,
        context?: string,
        error?: unknown,
    ) {
        const entry: LogEntry = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            level,
            message,
            context,
            error,
        };

        this._logs.unshift(entry);
        if (this._logs.length > this.MAX_LOGS) {
            this._logs.pop();
        }
    }
}

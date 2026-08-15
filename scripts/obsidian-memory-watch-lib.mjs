import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MEBIBYTE = 1024 * 1024;
const CSV_HEADER = [
    "timestamp",
    "label",
    "mode",
    "documents",
    "nodes",
    "jsEventListeners",
    "usedSize",
    "totalSize",
    "embedderHeapUsedSize",
    "backingStorageSize",
    "processCount",
    "privateBytes",
    "workingSetBytes",
    "deltaDocuments",
    "deltaNodes",
    "deltaListeners",
    "deltaUsedSize",
    "deltaBackingStorageSize",
    "deltaPrivateBytes",
    "assessment",
];

export function defaultCliPath() {
    if (process.env.OBSIDIAN_CLI) return process.env.OBSIDIAN_CLI;
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        return join(
            process.env.LOCALAPPDATA,
            "Programs",
            "Obsidian",
            "Obsidian.com",
        );
    }
    return "obsidian";
}

export function defaultOutputPath() {
    const timestamp = new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replaceAll(".", "-");
    return resolve(".memory-logs", `obsidian-memory-${timestamp}.csv`);
}

function parseJsonObject(output, commandName) {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start === -1 || end < start) {
        throw new Error(`${commandName} did not return a JSON object: ${output}`);
    }
    return JSON.parse(output.slice(start, end + 1));
}

function csvCell(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (![",", "\"", "\n", "\r"].some((character) => text.includes(character))) {
        return text;
    }
    return `"${text.replaceAll("\"", "\"\"")}"`;
}

function formatMebibytes(bytes) {
    if (bytes === null || bytes === undefined) return "-";
    return (bytes / MEBIBYTE).toFixed(1);
}

function formatDelta(value, formatter = String) {
    if (value === null || value === undefined) return "-";
    const prefix = value > 0 ? "+" : "";
    return `${prefix}${formatter(value)}`;
}

function pad(value, width) {
    const text = String(value);
    return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function assessSample(sample, previousGcSample) {
    if (sample.mode !== "gc") return "observation only";
    if (!previousGcSample) return "GC baseline";

    const warnings = [];
    if (sample.deltaBackingStorageSize > 16 * MEBIBYTE) {
        warnings.push("backing storage rising");
    }
    if (sample.deltaDocuments > 0) warnings.push("documents rising");
    if (sample.deltaUsedSize > 32 * MEBIBYTE) warnings.push("JS heap rising");
    if (sample.deltaNodes > 1000) warnings.push("DOM nodes rising");
    if (sample.deltaListeners > 200) warnings.push("listeners rising");
    if (warnings.length > 0) return `CHECK: ${warnings.join(", ")}`;

    if (sample.deltaPrivateBytes > 64 * MEBIBYTE) {
        return "stable refs; private high-water only";
    }
    return "stable";
}

export class ObsidianMemoryWatch {
    constructor(options) {
        this.options = options;
        this.debuggerAttached = false;
        this.previousGcSample = null;
        this.sampleNumber = 0;
        this.stopping = false;
    }

    get vaultArguments() {
        return this.options.vault ? [`vault=${this.options.vault}`] : [];
    }

    async runCli(argumentsList) {
        const { stderr, stdout } = await execFileAsync(
            this.options.cli,
            [...argumentsList, ...this.vaultArguments],
            { maxBuffer: 4 * MEBIBYTE, windowsHide: true },
        );
        if (stderr.trim()) console.warn(stderr.trim());
        return stdout.trim();
    }

    async attachDebugger() {
        const output = await this.runCli(["dev:debug", "on"]);
        this.debuggerAttached = true;
        console.log(output || "Debugger attached.");
    }

    async detachDebugger() {
        if (!this.debuggerAttached) return;
        this.debuggerAttached = false;
        try {
            const output = await this.runCli(["dev:debug", "off"]);
            console.log(output || "Debugger detached.");
        }
        catch (error) {
            console.warn(`Could not detach debugger: ${error.message}`);
        }
    }

    async collectGarbage() {
        await this.runCli(["dev:cdp", "method=HeapProfiler.collectGarbage"]);
        await this.runCli(["dev:cdp", "method=HeapProfiler.collectGarbage"]);
    }

    async getProcessMemory() {
        if (process.platform !== "win32") {
            return {
                privateBytes: null,
                processCount: null,
                workingSetBytes: null,
            };
        }

        const script = [
            "$processes = @(Get-Process -Name Obsidian -ErrorAction SilentlyContinue)",
            "$privateBytes = ($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum",
            "$workingSetBytes = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum",
            "[pscustomobject]@{ processCount = $processes.Count; privateBytes = [long]$privateBytes; workingSetBytes = [long]$workingSetBytes } | ConvertTo-Json -Compress",
        ].join("; ");
        const { stdout } = await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { windowsHide: true },
        );
        return parseJsonObject(stdout.trim(), "Get-Process");
    }

    async readMetrics() {
        const [domOutput, heapOutput, processMemory] = await Promise.all([
            this.runCli(["dev:cdp", "method=Memory.getDOMCounters"]),
            this.runCli(["dev:cdp", "method=Runtime.getHeapUsage"]),
            this.getProcessMemory(),
        ]);
        return {
            ...parseJsonObject(domOutput, "Memory.getDOMCounters"),
            ...parseJsonObject(heapOutput, "Runtime.getHeapUsage"),
            ...processMemory,
        };
    }

    async prepareCsv() {
        await mkdir(dirname(this.options.output), { recursive: true });
        if (!existsSync(this.options.output)) {
            await writeFile(this.options.output, `${CSV_HEADER.join(",")}\n`, {
                encoding: "utf8",
                flag: "wx",
            });
        }
    }

    async writeSample(sample) {
        const row = CSV_HEADER.map((key) => csvCell(sample[key])).join(",");
        await appendFile(this.options.output, `${row}\n`, "utf8");
    }

    printSample(sample) {
        const fields = [
            pad(sample.label, 20),
            pad(sample.mode, 7),
            pad(sample.documents, 6),
            pad(sample.nodes, 9),
            pad(sample.jsEventListeners, 10),
            pad(`${formatMebibytes(sample.usedSize)} MB`, 10),
            pad(`${formatMebibytes(sample.backingStorageSize)} MB`, 11),
            pad(`${formatMebibytes(sample.privateBytes)} MB`, 11),
            pad(formatDelta(sample.deltaDocuments), 7),
            pad(
                formatDelta(
                    sample.deltaBackingStorageSize,
                    (value) => `${formatMebibytes(value)} MB`,
                ),
                12,
            ),
            sample.assessment,
        ];
        console.log(fields.join(" "));
    }

    printHeader() {
        console.log(
            [
                pad("Checkpoint", 20),
                pad("Mode", 7),
                pad("Docs", 6),
                pad("Nodes", 9),
                pad("Listeners", 10),
                pad("JS heap", 10),
                pad("Backing", 11),
                pad("Private", 11),
                pad("ΔDocs", 7),
                pad("ΔBacking", 12),
                "Assessment",
            ].join(" "),
        );
    }

    async sample(label, mode) {
        if (mode === "gc") {
            console.log("Collecting garbage twice...");
            await this.collectGarbage();
        }

        const metrics = await this.readMetrics();
        const previous = this.previousGcSample;
        const sample = {
            ...metrics,
            assessment: "",
            deltaBackingStorageSize: previous
                ? metrics.backingStorageSize - previous.backingStorageSize
                : null,
            deltaDocuments: previous
                ? metrics.documents - previous.documents
                : null,
            deltaListeners: previous
                ? metrics.jsEventListeners - previous.jsEventListeners
                : null,
            deltaNodes: previous ? metrics.nodes - previous.nodes : null,
            deltaPrivateBytes:
                previous && metrics.privateBytes !== null
                && previous.privateBytes !== null
                    ? metrics.privateBytes - previous.privateBytes
                    : null,
            deltaUsedSize: previous
                ? metrics.usedSize - previous.usedSize
                : null,
            label,
            mode,
            timestamp: new Date().toISOString(),
        };
        sample.assessment = assessSample(sample, previous);

        await this.writeSample(sample);
        this.printSample(sample);
        if (mode === "gc") this.previousGcSample = sample;
        return sample;
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        await this.detachDebugger();
        console.log(`CSV: ${this.options.output}`);
    }
}

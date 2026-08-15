import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import readline from "node:readline";

import {
    defaultCliPath,
    defaultOutputPath,
    ObsidianMemoryWatch,
} from "./obsidian-memory-watch-lib.mjs";

function printHelp() {
    console.log(`Usage: npm run memory:watch -- [options]

Options:
  --vault <name>    Target vault name. Defaults to the active vault.
  --output <path>   CSV output path. Defaults to .memory-logs/.
  --cli <path>      Obsidian CLI path. Defaults to OBSIDIAN_CLI or the
                    standard Windows installation path.
  --once            Take one double-GC sample and exit.
  --help            Show this help.

Interactive commands:
  Enter             Take a passive sample without forcing GC.
  s <label>         Take a labelled passive sample.
  g <label>         Run GC twice, then take a labelled sample.
  h                 Show the interactive commands.
  q                 Detach the debugger and quit.

Environment variables:
  OBSIDIAN_CLI       Override the Obsidian CLI executable.
  OBSIDIAN_VAULT     Default vault name.`);
}

function takeOptionValue(argv, index, option) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}

function parseOptions(argv) {
    const options = {
        cli: defaultCliPath(),
        help: false,
        once: false,
        output: defaultOutputPath(),
        vault: process.env.OBSIDIAN_VAULT ?? "",
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        switch (argument) {
            case "--cli":
                options.cli = takeOptionValue(argv, index, argument);
                index += 1;
                break;
            case "--help":
                options.help = true;
                break;
            case "--once":
                options.once = true;
                break;
            case "--output":
                options.output = resolve(
                    takeOptionValue(argv, index, argument),
                );
                index += 1;
                break;
            case "--vault":
                options.vault = takeOptionValue(argv, index, argument);
                index += 1;
                break;
            default:
                throw new Error(`Unknown option: ${argument}`);
        }
    }
    return options;
}

function printInteractiveHelp() {
    console.log(
        "Commands: Enter=sample, s <label>=sample, g <label>=double-GC sample, h=help, q=quit",
    );
}

async function runInteractive(watch) {
    printInteractiveHelp();
    const interfaceInstance = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "memory> ",
    });
    let busy = false;

    const stop = async () => {
        interfaceInstance.close();
        await watch.stop();
    };

    interfaceInstance.on("line", async (line) => {
        const commandLine = line.trim();
        if (busy) {
            console.log("A sample is still running.");
            interfaceInstance.prompt();
            return;
        }
        if (commandLine === "q") {
            await stop();
            return;
        }
        if (commandLine === "h") {
            printInteractiveHelp();
            interfaceInstance.prompt();
            return;
        }

        busy = true;
        try {
            const [command = "", ...labelParts] = commandLine.split(" ");
            const label = labelParts.join(" ")
                || `sample-${String(++watch.sampleNumber).padStart(2, "0")}`;
            if (command === "g") {
                await watch.sample(label, "gc");
            }
            else if (command === "" || command === "s") {
                await watch.sample(label, "passive");
            }
            else {
                console.log(`Unknown command: ${command}. Type h for help.`);
            }
        }
        catch (error) {
            console.error(`Sample failed: ${error.message}`);
        }
        finally {
            busy = false;
            if (!watch.stopping) interfaceInstance.prompt();
        }
    });

    interfaceInstance.on("SIGINT", () => {
        void stop();
    });
    interfaceInstance.on("close", () => {
        if (!watch.stopping) void watch.stop();
    });
    interfaceInstance.prompt();
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    if (isAbsolute(options.cli) && !existsSync(options.cli)) {
        throw new Error(
            `Obsidian CLI not found at ${options.cli}. Pass --cli or set OBSIDIAN_CLI.`,
        );
    }

    const watch = new ObsidianMemoryWatch(options);
    await watch.prepareCsv();
    console.log(`CSV: ${options.output}`);

    try {
        await watch.attachDebugger();
        watch.printHeader();
        await watch.sample("baseline", "gc");
        if (options.once) {
            await watch.stop();
            return;
        }
        await runInteractive(watch);
    }
    catch (error) {
        await watch.stop();
        throw error;
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});

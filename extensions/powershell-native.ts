/**
 * PowerShell Native Tool for pi on Windows
 *
 * What it does:
 * - Registers a native `powershell` tool that runs commands through PowerShell
 *   (pwsh.exe if available, otherwise Windows PowerShell).
 * - Disables the built-in `bash` tool on Windows so the model is forced to use
 *   PowerShell instead.
 * - Routes interactive `!command` / `!!command` user bash shortcuts through
 *   PowerShell as well.
 * - Adds a system-prompt reminder to always prefer `powershell` on Windows.
 *
 * Installation:
 *   Copy this file to:
 *     %USERPROFILE%\.pi\agent\extensions\powershell-native.ts
 *
 *   It is auto-discovered on the next pi start. Use `pi /reload` to load it
 *   without restarting.
 *
 *   You can override the PowerShell executable with the environment variable:
 *     PI_POWERSHELL_PATH=C:\Path\To\pwsh.exe
 *
 * Example usage:
 *   powershell  Get-Date | Out-String
 *   powershell  Get-ChildItem | Out-String
 *   powershell  Get-ChildItem -Name
 *   powershell  (Get-Location).Path
 *   powershell  whoami
 *
 * Tip: Many PowerShell cmdlets return objects, not plain strings. If the output
 * looks empty or has unexpected formatting, pipe the command to `Out-String` or
 * access a specific property such as `(Get-Location).Path`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PowerShellToolDetails {
	exitCode: number;
	truncated?: boolean;
	fullOutputPath?: string;
	truncation?: TruncationResult;
}

const powerShellSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
});

// ---------------------------------------------------------------------------
// PowerShell discovery
// ---------------------------------------------------------------------------

let cachedShell: string | undefined;

function findPowerShellPath(): string {
	if (cachedShell) return cachedShell;

	const envPath = process.env.PI_POWERSHELL_PATH;
	if (envPath) {
		cachedShell = envPath;
		return cachedShell;
	}

	for (const shell of ["pwsh.exe", "powershell.exe"]) {
		try {
			const result = spawnSync("where", [shell], {
				encoding: "utf8",
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout.trim().length > 0) {
				cachedShell = shell;
				return cachedShell;
			}
		} catch {
			// fall through to next candidate
		}
	}

	// Fallback if nothing is on PATH.
	cachedShell = "powershell.exe";
	return cachedShell;
}

// ---------------------------------------------------------------------------
// Core PowerShell execution
// ---------------------------------------------------------------------------

async function execPowerShell(
	command: string,
	cwd: string,
	options: {
		signal?: AbortSignal;
		timeout?: number;
		onData?: (chunk: string) => void;
	} = {},
): Promise<{ exitCode: number | null; output: string; timedOut: boolean; aborted: boolean }> {
	try {
		await access(cwd, constants.F_OK);
	} catch {
		throw new Error(`Working directory does not exist: ${cwd}`);
	}

	const shell = findPowerShellPath();

	// Wrap the user's command so native command exit codes are propagated.
	const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
${command}
exit $LASTEXITCODE`;

	const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
	const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];

	const child = spawn(shell, args, {
		cwd,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const chunks: string[] = [];
	let killed = false;
	let timedOut = false;
	let aborted = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	const killTree = () => {
		if (killed || !child.pid) return;
		killed = true;
		try {
			spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
				windowsHide: true,
				stdio: "ignore",
			});
		} catch {
			// best effort
		}
	};

	const onAbort = () => {
		aborted = true;
		killTree();
	};

	if (options.signal?.aborted) {
		onAbort();
	} else {
		options.signal?.addEventListener("abort", onAbort, { once: true });
	}

	if (options.timeout && options.timeout > 0) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			killTree();
		}, options.timeout * 1000);
	}

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	const collect = (data: string) => {
		const chunk = String(data);
		chunks.push(chunk);
		options.onData?.(chunk);
	};

	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	const result = await new Promise<{
		exitCode: number | null;
		output: string;
		timedOut: boolean;
		aborted: boolean;
	}>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode: code,
				output: chunks.join(""),
				timedOut,
				aborted,
			});
		});
	});

	return result;
}

// ---------------------------------------------------------------------------
// Output handling (truncation + temp file for full output)
// ---------------------------------------------------------------------------

async function buildResultOutput(
	fullOutput: string,
): Promise<{ text: string; details: PowerShellToolDetails; fullOutputPath?: string }> {
	const truncation = truncateTail(fullOutput, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let text = truncation.content || "(no output)";
	const details: PowerShellToolDetails = {
		exitCode: 0,
		truncated: truncation.truncated,
		truncation,
	};

	if (truncation.truncated && fullOutput) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-powershell-"));
		const fullOutputPath = join(tempDir, "output.txt");
		await writeFile(fullOutputPath, fullOutput, "utf8");
		details.fullOutputPath = fullOutputPath;

		const startLine = truncation.totalLines - truncation.outputLines + 1;
		const endLine = truncation.totalLines;

		if (truncation.lastLinePartial) {
			text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${fullOutputPath}]`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
		} else {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
		}
	}

	return { text, details, fullOutputPath: details.fullOutputPath };
}

class OutputBuffer {
	private chunks: string[] = [];

	append(chunk: string) {
		this.chunks.push(chunk);
	}

	toString() {
		return this.chunks.join("");
	}

	snapshot() {
		const full = this.toString();
		const truncation = truncateTail(full, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		return {
			content: truncation.content || "",
			truncation,
			full,
		};
	}
}

type UpdateCallback = (result: {
	content: Array<{ type: "text"; text: string }>;
	details: PowerShellToolDetails;
}) => void;

function createUpdater(buffer: OutputBuffer, onUpdate: UpdateCallback) {
	const THROTTLE_MS = 100;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let lastAt = 0;

	const emit = () => {
		if (!dirty) return;
		dirty = false;
		lastAt = Date.now();
		const snap = buffer.snapshot();
		onUpdate({
			content: [{ type: "text", text: snap.content }],
			details: {
				exitCode: 0,
				truncated: snap.truncation.truncated,
				truncation: snap.truncation.truncated ? snap.truncation : undefined,
			},
		});
	};

	const schedule = () => {
		dirty = true;
		const delay = THROTTLE_MS - (Date.now() - lastAt);
		if (delay <= 0) {
			clearTimeout(timer);
			emit();
			return;
		}
		timer ??= setTimeout(() => {
			timer = undefined;
			emit();
		}, delay);
	};

	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		emit();
	};

	return { schedule, flush };
}

// ---------------------------------------------------------------------------
// Extension setup
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Nothing to do on non-Windows platforms.
	if (process.platform !== "win32") {
		return;
	}

	// -------------------------------------------------------------------------
	// Register the native PowerShell tool
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "powershell",
		label: "PowerShell",
		description: `Execute a PowerShell command in the current working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, the full output is saved to a temp file. Optionally provide a timeout in seconds. PowerShell cmdlets return objects by default; if output looks empty or oddly formatted, pipe to Out-String (e.g. Get-ChildItem | Out-String) or access a property directly (e.g. (Get-Location).Path).`,
		promptSnippet: "Execute PowerShell commands on Windows (ls, Get-ChildItem, Find-String, etc.)",
		promptGuidelines: [
			"On Windows, always use the `powershell` tool for shell commands instead of `bash`.",
			"Use `powershell` for directory listings, file searches, git operations, and any command that would normally run in a shell.",
			"PowerShell cmdlets return objects, not plain strings. If the output looks empty or oddly formatted, pipe to `Out-String` (e.g. `Get-ChildItem | Out-String`) or access a specific property (e.g. `(Get-Location).Path`).",
		],
		parameters: powerShellSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const buffer = new OutputBuffer();
			const updater = onUpdate ? createUpdater(buffer, onUpdate) : null;

			const execResult = await execPowerShell(params.command, ctx.cwd, {
				signal,
				timeout: params.timeout,
				onData: (chunk) => {
					buffer.append(chunk);
					updater?.schedule();
				},
			});

			updater?.flush();

			if (execResult.aborted) {
				throw new Error("Command aborted");
			}
			if (execResult.timedOut) {
				throw new Error(`Command timed out after ${params.timeout} seconds`);
			}

			const { text: outputText, details, fullOutputPath } = await buildResultOutput(buffer.toString());
			details.exitCode = execResult.exitCode ?? 0;

			const finalText =
				execResult.exitCode !== 0 && execResult.exitCode !== null
					? `${outputText}\n\n[Command exited with code ${execResult.exitCode}]`
					: outputText;

			if (execResult.exitCode !== 0 && execResult.exitCode !== null) {
				throw new Error(finalText);
			}

			return {
				content: [{ type: "text", text: finalText }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const command = args.command || "...";
			const timeout = args.timeout;
			const timeoutSuffix = timeout
				? theme.fg("muted", ` (timeout ${timeout}s)`)
				: "";
			const text =
				theme.fg("toolTitle", theme.bold("> powershell ")) +
				theme.fg("accent", command) +
				timeoutSuffix;
			return new Text(text, 0, 0);
		},
	});

	// -------------------------------------------------------------------------
	// Disable bash and ensure powershell is active whenever a session starts
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, _ctx) => {
		const active = new Set(pi.getActiveTools());
		let changed = false;

		if (active.has("bash")) {
			active.delete("bash");
			changed = true;
		}
		if (!active.has("powershell")) {
			active.add("powershell");
			changed = true;
		}

		if (changed) {
			pi.setActiveTools([...active]);
		}
	});

	// -------------------------------------------------------------------------
	// Block any stray bash tool calls on Windows
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "bash") {
			return {
				block: true,
				reason: "bash is disabled on Windows. Use the powershell tool instead.",
			};
		}
	});

	// -------------------------------------------------------------------------
	// Remind the model every turn to prefer PowerShell on Windows
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (event, _ctx) => {
		const instruction =
			"\n\nYou are running on Windows. Always use the `powershell` tool for shell commands. " +
			"Do not use the `bash` tool; it is disabled.";
		return { systemPrompt: event.systemPrompt + instruction };
	});

	// -------------------------------------------------------------------------
	// Route ! / !! user shell shortcuts through PowerShell
	// -------------------------------------------------------------------------
	pi.on("user_bash", async (event, _ctx) => {
		const result = await execPowerShell(event.command, event.cwd);

		if (result.aborted) {
			return {
				result: {
					output: "Command aborted",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				},
			};
		}

		const { text, details } = await buildResultOutput(result.output);
		const output =
			result.exitCode !== 0 && result.exitCode !== null
				? `${text}\n\n[Command exited with code ${result.exitCode}]`
				: text;

		return {
			result: {
				output,
				exitCode: result.exitCode ?? undefined,
				cancelled: false,
				truncated: details.truncated ?? false,
				fullOutputPath: details.fullOutputPath,
			},
		};
	});
}

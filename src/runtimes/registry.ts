/** Runtime registry — real adapters that capture output, parse cost, handle Windows */

import type { AgentRuntime, AgentStatus, AgentTask, CostEntry, RunHandle } from "../types.ts";
import { parseCostFromOutput, parseModel } from "../pipeline/cost-parser.ts";

// ── Runtime definitions ────────────────────────────────────────

interface RuntimeDef {
	cmd: string;
	buildArgs: (prompt: string, model?: string) => string[];
	/** This runtime emits cost/model info in stderr that cost-parser can handle */
	parsesCost?: boolean;
}

const RUNTIMES: Record<string, RuntimeDef> = {
	pi: {
		cmd: "pi",
		buildArgs: (p, m) => (m ? ["-p", "--model", m, p] : ["-p", p]),
		parsesCost: true,
	},
	claude: {
		cmd: "claude",
		buildArgs: (p, m) => (m ? ["--print", "--model", m, p] : ["--print", p]),
		parsesCost: true,
	},
	codex: {
		cmd: "codex",
		buildArgs: (p, m) => (m ? ["--quiet", "--model", m, p] : ["--quiet", p]),
	},
	"gemini-cli": {
		cmd: "gemini",
		buildArgs: (p, m) => (m ? ["--model", m, p] : [p]),
	},
	aider: {
		cmd: "aider",
		buildArgs: (p, m) =>
			m ? ["--message", p, "--yes", "--model", m] : ["--message", p, "--yes"],
	},
	goose: {
		cmd: "goose",
		buildArgs: (p) => ["run", "--text", p],
	},
	amp: {
		cmd: "amp",
		buildArgs: (p) => ["--prompt", p],
	},
};

// ── Active process tracking ────────────────────────────────────

interface TrackedProcess {
	proc: ReturnType<typeof Bun.spawn>;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	settled: boolean;
}

const tracked = new Map<number, TrackedProcess>();

// ── Which/where detection (Windows-safe) ───────────────────────

const IS_WIN = process.platform === "win32";
const WHICH = IS_WIN ? "where" : "which";

async function commandExists(cmd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([WHICH, cmd], { stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) return undefined;
		const out = await new Response(proc.stdout).text();
		return out.trim().split("\n")[0]?.trim();
	} catch {
		return undefined;
	}
}

// ── Runtime adapter factory ────────────────────────────────────

function createRuntime(name: string, def: RuntimeDef): AgentRuntime {
	return {
		name,

		async available(): Promise<boolean> {
			return (await commandExists(def.cmd)) !== undefined;
		},

		async spawn(task: AgentTask): Promise<RunHandle> {
			const args = def.buildArgs(task.prompt, task.model);
			const proc = Bun.spawn([def.cmd, ...args], {
				cwd: task.cwd ?? process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});

			const tp: TrackedProcess = {
				proc,
				stdout: "",
				stderr: "",
				exitCode: null,
				settled: false,
			};
			tracked.set(proc.pid, tp);

			// Async drain stdout + stderr into buffers
			(async () => {
				try {
					tp.stdout = await new Response(proc.stdout).text();
				} catch { /* stream closed */ }
			})();
			(async () => {
				try {
					tp.stderr = await new Response(proc.stderr).text();
				} catch { /* stream closed */ }
			})();
			(async () => {
				tp.exitCode = await proc.exited;
				tp.settled = true;
			})();

			return {
				pid: proc.pid,
				runtime: name,
				startedAt: new Date().toISOString(),
			};
		},

		async status(handle: RunHandle): Promise<AgentStatus> {
			const tp = tracked.get(handle.pid);
			if (!tp) return "completed";
			return tp.settled ? (tp.exitCode === 0 ? "completed" : "failed") : "running";
		},

		async kill(handle: RunHandle): Promise<void> {
			const tp = tracked.get(handle.pid);
			if (!tp || tp.settled) return;
			try {
				tp.proc.kill("SIGTERM");
				// Give it 3s then force
				setTimeout(() => {
					if (!tp.settled) tp.proc.kill("SIGKILL");
				}, 3000);
			} catch { /* already dead */ }
		},

		async output(handle: RunHandle): Promise<string> {
			const tp = tracked.get(handle.pid);
			if (!tp) return "";
			// Wait for process to finish if still running
			if (!tp.settled) {
				tp.exitCode = await tp.proc.exited;
				tp.settled = true;
			}
			return tp.stdout;
		},

		async cost(handle: RunHandle): Promise<CostEntry | undefined> {
			const tp = tracked.get(handle.pid);
			if (!tp) return undefined;
			if (!tp.settled) {
				tp.exitCode = await tp.proc.exited;
				tp.settled = true;
			}
			if (!def.parsesCost) return undefined;
			return parseCostFromOutput(name, tp.stdout, tp.stderr) ?? undefined;
		},
	};
}

// ── Public API ─────────────────────────────────────────────────

/** Get a runtime by name. Returns a real adapter for known runtimes, generic for unknown. */
export function getRuntime(name: string): AgentRuntime {
	const def = RUNTIMES[name];
	if (def) return createRuntime(name, def);

	// Generic fallback — just run the command with the prompt as argument
	return createRuntime(name, {
		cmd: name,
		buildArgs: (p) => [p],
	});
}

/** All registered runtime names */
export function listRuntimes(): string[] {
	return Object.keys(RUNTIMES);
}

/** Discover which runtimes are available on this machine */
export async function discoverRuntimes(): Promise<
	Array<{ name: string; available: boolean; path?: string }>
> {
	const results: Array<{ name: string; available: boolean; path?: string }> = [];
	for (const [name, def] of Object.entries(RUNTIMES)) {
		const path = await commandExists(def.cmd);
		results.push({ name, available: !!path, path });
	}
	return results;
}

/** Wait for a tracked process to finish and clean up */
export async function awaitHandle(handle: RunHandle): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const tp = tracked.get(handle.pid);
	if (!tp) return { stdout: "", stderr: "", exitCode: -1 };
	if (!tp.settled) {
		tp.exitCode = await tp.proc.exited;
		tp.settled = true;
	}
	// Small delay to let async drains finish
	await new Promise((r) => setTimeout(r, 50));
	const result = { stdout: tp.stdout, stderr: tp.stderr, exitCode: tp.exitCode ?? -1 };
	tracked.delete(handle.pid);
	return result;
}

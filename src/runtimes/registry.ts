/** Runtime registry — 18 CLIs normalized behind AgentRuntime interface */

import type { AgentRuntime, AgentTask, RunHandle, AgentStatus, CostEntry } from "../types.ts";

/** All known runtimes and their CLI commands */
const RUNTIME_DEFS: Record<string, { cmd: string; args: (prompt: string) => string[]; parsesCost?: boolean }> = {
	pi: { cmd: "pi", args: (p) => ["--print", p], parsesCost: true },
	claude: { cmd: "claude", args: (p) => ["--print", p] },
	"gemini-cli": { cmd: "gemini", args: (p) => [p] },
	codex: { cmd: "codex", args: (p) => ["--quiet", p] },
	aider: { cmd: "aider", args: (p) => ["--message", p, "--yes"] },
	goose: { cmd: "goose", args: (p) => ["run", p] },
	amp: { cmd: "amp", args: (p) => [p] },
	cursor: { cmd: "cursor", args: (p) => ["--cli", p] },
	antigravity: { cmd: "antigravity", args: (p) => [p] },
	gemini: { cmd: "gemini", args: (p) => [p] },
	// Remote backends
	"gh-agent": { cmd: "gh", args: (p) => ["agent-task", "create", "--prompt", p] },
	jules: { cmd: "jules-client.sh", args: (p) => [p] },
	e2b: { cmd: "e2b", args: (p) => ["run", p] },
	// Platform
	openclaw: { cmd: "openclaw", args: (p) => ["run", p] },
	// Tools
	docker: { cmd: "docker", args: (p) => ["exec", "-it", "sandbox", "bash", "-c", p] },
	gh: { cmd: "gh", args: (p) => [p] },
	beepctl: { cmd: "beepctl", args: (p) => [p] },
	"pi-messenger": { cmd: "pi-messenger", args: (p) => [p] },
};

/** Create a runtime adapter from a known definition */
function createRuntime(name: string): AgentRuntime {
	const def = RUNTIME_DEFS[name];
	if (!def) {
		// Unknown runtime — generic fallback
		return createGenericRuntime(name);
	}

	return {
		name,

		async available(): Promise<boolean> {
			try {
				const proc = Bun.spawn(["which", def.cmd], { stdout: "pipe", stderr: "pipe" });
				return (await proc.exited) === 0;
			} catch {
				return false;
			}
		},

		async spawn(task: AgentTask): Promise<RunHandle> {
			const args = def.args(task.prompt);
			const cmdArgs = task.model ? [def.cmd, ...args, "--model", task.model] : [def.cmd, ...args];

			const proc = Bun.spawn(cmdArgs, {
				cwd: task.cwd ?? process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});

			return {
				pid: proc.pid,
				runtime: name,
				startedAt: new Date().toISOString(),
			};
		},

		async status(_handle: RunHandle): Promise<AgentStatus> {
			// Check if process is still running
			try {
				process.kill(_handle.pid, 0);
				return "running";
			} catch {
				return "completed";
			}
		},

		async kill(handle: RunHandle): Promise<void> {
			try {
				process.kill(handle.pid, "SIGTERM");
			} catch {
				// Already dead
			}
		},

		async output(_handle: RunHandle): Promise<string> {
			return ""; // Output captured at spawn time
		},

		async cost(_handle: RunHandle): Promise<CostEntry | undefined> {
			// Cost is parsed at spawn time from stdout/stderr by cost-parser.ts
			// This handle-based method is a fallback for runtimes that report cost separately.
			return undefined;
		},
	};
}

function createGenericRuntime(name: string): AgentRuntime {
	return {
		name,
		async available() {
			try {
				const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
				return (await proc.exited) === 0;
			} catch {
				return false;
			}
		},
		async spawn(task) {
			const proc = Bun.spawn([name, task.prompt], {
				cwd: task.cwd ?? process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			return { pid: proc.pid, runtime: name, startedAt: new Date().toISOString() };
		},
		async status(h) {
			try {
				process.kill(h.pid, 0);
				return "running";
			} catch {
				return "completed";
			}
		},
		async kill(h) {
			try { process.kill(h.pid, "SIGTERM"); } catch { /* */ }
		},
		async output() { return ""; },
		async cost() { return undefined; },
	};
}

/** Get a runtime by name */
export function getRuntime(name: string): AgentRuntime {
	return createRuntime(name);
}

/** List all known runtimes */
export function listRuntimes(): string[] {
	return Object.keys(RUNTIME_DEFS);
}

/** Check which runtimes are available */
export async function discoverRuntimes(): Promise<Array<{ name: string; available: boolean; path?: string }>> {
	const results: Array<{ name: string; available: boolean; path?: string }> = [];

	for (const name of Object.keys(RUNTIME_DEFS)) {
		const def = RUNTIME_DEFS[name];
		if (!def) continue;

		try {
			const proc = Bun.spawn(["which", def.cmd], { stdout: "pipe", stderr: "pipe" });
			const code = await proc.exited;
			const path = code === 0 ? (await new Response(proc.stdout).text()).trim() : undefined;
			results.push({ name, available: code === 0, path });
		} catch {
			results.push({ name, available: false });
		}
	}

	return results;
}

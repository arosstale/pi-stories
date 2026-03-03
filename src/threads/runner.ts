/** Thread runner — execute any of the 7 thread types */

import { randomUUID } from "node:crypto";
import chalk from "chalk";
import type { ThreadConfig, ThreadMetrics, ChainStep } from "./types.ts";
import { CHAIN_TEMPLATES, TEAM_PRESETS } from "./types.ts";
import { createSession, updateSession, getActiveSessions } from "../sessions/store.ts";
import { sendMail } from "../mail/store.ts";
import { getConfigDir } from "../config.ts";
import type { AgentRole } from "../types.ts";

export interface ThreadResult {
	threadId: string;
	type: string;
	status: "completed" | "failed" | "timeout" | "partial";
	metrics: ThreadMetrics;
	outputs: string[];
}

/** Execute a thread of any type */
export async function runThread(config: ThreadConfig, cwd: string): Promise<ThreadResult> {
	const threadId = randomUUID().slice(0, 8);
	const configDir = getConfigDir(cwd);
	const startTime = Date.now();

	console.log(chalk.bold(`\n🧵 Thread ${threadId} [${config.type}] — ${config.name}`));
	console.log(chalk.dim(`   Task: ${config.task.slice(0, 80)}\n`));

	const metrics: ThreadMetrics = {
		threadId,
		type: config.type,
		toolCalls: 0,
		duration: 0,
		checkpoints: 0,
		cost: 0,
		width: config.width ?? 1,
		depth: 0,
		reviewed: config.requireReview ?? config.type !== "Z",
	};

	let outputs: string[] = [];
	let status: ThreadResult["status"] = "completed";

	try {
		switch (config.type) {
			case "base":
				outputs = await runBaseThread(config, cwd, configDir, metrics);
				break;
			case "P":
				outputs = await runPThread(config, cwd, configDir, metrics);
				break;
			case "C":
				outputs = await runCThread(config, cwd, configDir, metrics);
				break;
			case "F":
				outputs = await runFThread(config, cwd, configDir, metrics);
				break;
			case "B":
				outputs = await runBThread(config, cwd, configDir, metrics);
				break;
			case "L":
				outputs = await runLThread(config, cwd, configDir, metrics);
				break;
			case "Z":
				outputs = await runZThread(config, cwd, configDir, metrics);
				break;
		}
	} catch (err) {
		status = "failed";
		console.error(chalk.red(`Thread ${threadId} failed: ${err}`));
	}

	metrics.duration = (Date.now() - startTime) / 1000;

	return { threadId, type: config.type, status, metrics, outputs };
}

/** Base thread: single prompt → tool calls → review */
async function runBaseThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	const runtime = config.runtimes?.[0] ?? "pi";
	const session = createSession(configDir, {
		name: `base-${Date.now().toString(36)}`,
		runtime,
		role: (config.roles?.[0] ?? "builder") as AgentRole,
		task: config.task,
	});

	const proc = Bun.spawn([runtime, "--print", config.task], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	updateSession(configDir, session.id, { pid: proc.pid });
	const exitCode = await proc.exited;
	const output = await new Response(proc.stdout).text();

	updateSession(configDir, session.id, {
		status: exitCode === 0 ? "completed" : "failed",
	});

	return [output];
}

/** P-Thread: parallel execution — N agents on independent tasks */
async function runPThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	const width = config.width ?? 3;
	const runtime = config.runtimes?.[0] ?? "pi";
	metrics.width = width;

	console.log(chalk.dim(`  ⚡ Launching ${width} parallel agents`));

	const promises = Array.from({ length: width }, async (_, i) => {
		const role = config.roles?.[i % (config.roles?.length ?? 1)] ?? "builder";
		const name = `p-${role}-${i}`;

		const session = createSession(configDir, {
			name,
			runtime,
			role: role as AgentRole,
			task: config.task,
		});

		const proc = Bun.spawn([runtime, "--print", `[${role}] ${config.task}`], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		updateSession(configDir, session.id, { pid: proc.pid });
		const code = await proc.exited;
		const output = await new Response(proc.stdout).text();

		updateSession(configDir, session.id, {
			status: code === 0 ? "completed" : "failed",
		});

		console.log(`    ${code === 0 ? chalk.green("✓") : chalk.red("✗")} ${name}`);
		return output;
	});

	return Promise.all(promises);
}

/** C-Thread: chained with checkpoints — each step feeds the next */
async function runCThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	const steps = config.steps ?? CHAIN_TEMPLATES["plan-build-review"]?.steps ?? [];
	const runtime = config.runtimes?.[0] ?? "pi";
	const outputs: string[] = [];
	let currentInput = config.task;

	for (const [i, step] of steps.entries()) {
		console.log(chalk.dim(`  [${i + 1}/${steps.length}] ${step.agent}: processing...`));

		// Template substitution
		const prompt = step.prompt
			.replace(/\$INPUT/g, currentInput)
			.replace(/\$ORIGINAL/g, config.task);

		const session = createSession(configDir, {
			name: `chain-${step.agent}-${i}`,
			runtime,
			role: step.agent as AgentRole,
			task: prompt.slice(0, 200),
		});

		const proc = Bun.spawn([runtime, "--print", prompt], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		updateSession(configDir, session.id, { pid: proc.pid });
		const code = await proc.exited;
		const output = await new Response(proc.stdout).text();

		updateSession(configDir, session.id, {
			status: code === 0 ? "completed" : "failed",
		});

		outputs.push(output);
		currentInput = output; // Feed output into next step's $INPUT
		metrics.checkpoints++;

		console.log(`    ${code === 0 ? chalk.green("✓") : chalk.red("✗")} ${step.agent} (step ${i + 1})`);

		if (code !== 0) break;
	}

	return outputs;
}

/** F-Thread: fusion — N agents on SAME task, pick the best */
async function runFThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	const width = config.width ?? 3;
	const strategy = config.fusionStrategy ?? "best-of-n";
	metrics.width = width;

	console.log(chalk.dim(`  🔀 Fusion: ${width} agents, strategy: ${strategy}`));

	// Launch all agents on the same task
	const promises = Array.from({ length: width }, async (_, i) => {
		const runtimes = config.runtimes ?? ["pi"];
		const runtime = runtimes[i % runtimes.length];
		const name = `fusion-${runtime}-${i}`;

		const session = createSession(configDir, {
			name,
			runtime,
			role: "builder" as AgentRole,
			task: config.task,
		});

		const proc = Bun.spawn([runtime, "--print", config.task], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		updateSession(configDir, session.id, { pid: proc.pid });
		const code = await proc.exited;
		const output = await new Response(proc.stdout).text();

		updateSession(configDir, session.id, {
			status: code === 0 ? "completed" : "failed",
		});

		return { output, runtime, success: code === 0, index: i };
	});

	const results = await Promise.all(promises);
	const successful = results.filter((r) => r.success);

	for (const r of results) {
		const icon = r.success ? chalk.green("✓") : chalk.red("✗");
		console.log(`    ${icon} fusion-${r.runtime}-${r.index} (${r.output.length} chars)`);
	}

	if (strategy === "best-of-n") {
		// Longest successful output = proxy for most thorough
		const best = successful.sort((a, b) => b.output.length - a.output.length)[0];
		console.log(chalk.dim(`  Winner: fusion-${best?.runtime}-${best?.index}`));
		return best ? [best.output] : [];
	}

	// cherry-pick and merge: return all outputs for manual selection
	return successful.map((r) => r.output);
}

/** B-Thread: meta — agents that spawn agents */
async function runBThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	metrics.depth = 1;

	// B-thread = orchestrator → sub-agents
	// Phase 1: Plan
	console.log(chalk.dim("  🧠 B-Thread: orchestrator planning..."));
	const planConfig: ThreadConfig = {
		type: "base",
		name: "b-plan",
		task: `You are an orchestrator. Plan how to break down this task into sub-tasks for parallel agents:\n\n${config.task}\n\nOutput a numbered list of sub-tasks.`,
		runtimes: config.runtimes,
		roles: ["planner"],
	};
	const planResult = await runBaseThread(planConfig, cwd, configDir, metrics);

	// Phase 2: Execute sub-tasks in parallel
	console.log(chalk.dim("  ⚡ B-Thread: dispatching sub-agents..."));
	const subConfig: ThreadConfig = {
		type: "P",
		name: "b-workers",
		task: config.task,
		width: config.width ?? 3,
		runtimes: config.runtimes,
		roles: config.roles ?? ["builder"],
	};
	const workerOutputs = await runPThread(subConfig, cwd, configDir, metrics);

	// Phase 3: Review
	console.log(chalk.dim("  📋 B-Thread: reviewing results..."));
	const reviewConfig: ThreadConfig = {
		type: "base",
		name: "b-review",
		task: `Review these results from multiple agents working on: ${config.task}\n\nResults:\n${workerOutputs.join("\n---\n")}`,
		runtimes: config.runtimes,
		roles: ["reviewer"],
	};
	const reviewResult = await runBaseThread(reviewConfig, cwd, configDir, metrics);

	return [...planResult, ...workerOutputs, ...reviewResult];
}

/** L-Thread: long-running — extended autonomy with timeout */
async function runLThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	const maxDuration = config.maxDuration ?? 3600000; // Default 1 hour
	const runtime = config.runtimes?.[0] ?? "pi";

	console.log(chalk.dim(`  ⏳ L-Thread: max duration ${(maxDuration / 60000).toFixed(0)} min`));

	const session = createSession(configDir, {
		name: `long-${Date.now().toString(36)}`,
		runtime,
		role: "builder" as AgentRole,
		task: config.task,
	});

	const proc = Bun.spawn([runtime, "--print", config.task], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	updateSession(configDir, session.id, { pid: proc.pid });

	// Race between completion and timeout
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		setTimeout(() => resolve("timeout"), maxDuration);
	});

	const completionPromise = proc.exited.then((code) => code);
	const result = await Promise.race([completionPromise, timeoutPromise]);

	if (result === "timeout") {
		try { process.kill(proc.pid, "SIGTERM"); } catch { /* */ }
		updateSession(configDir, session.id, { status: "killed" });
		console.log(chalk.yellow("  ⏰ L-Thread timed out"));
		return ["[TIMEOUT]"];
	}

	const output = await new Response(proc.stdout).text();
	updateSession(configDir, session.id, {
		status: result === 0 ? "completed" : "failed",
	});

	return [output];
}

/** Z-Thread: zero-touch — fire and forget, no review */
async function runZThread(
	config: ThreadConfig,
	cwd: string,
	configDir: string,
	metrics: ThreadMetrics,
): Promise<string[]> {
	metrics.reviewed = false;
	const runtime = config.runtimes?.[0] ?? "pi";

	console.log(chalk.dim("  🚀 Z-Thread: zero-touch, no review"));

	const session = createSession(configDir, {
		name: `zero-${Date.now().toString(36)}`,
		runtime,
		role: "builder" as AgentRole,
		task: config.task,
	});

	// Fire and forget — spawn detached
	const proc = Bun.spawn([runtime, "--print", config.task], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	updateSession(configDir, session.id, { pid: proc.pid });

	// Send notification via mail when done
	const pid = proc.pid;
	proc.exited.then((code) => {
		updateSession(configDir, session.id, {
			status: code === 0 ? "completed" : "failed",
		});
		sendMail(configDir, {
			from: `zero-${session.id}`,
			to: "orchestrator",
			subject: `Z-Thread ${code === 0 ? "completed" : "failed"}: ${config.task.slice(0, 50)}`,
			body: `Z-Thread completed with exit code ${code}`,
			type: code === 0 ? "worker_done" : "error",
			priority: code === 0 ? "normal" : "high",
		});
	});

	console.log(`  → Dispatched (PID: ${pid}). Check mail for result.`);

	return [`[Z-THREAD DISPATCHED: PID ${pid}]`];
}

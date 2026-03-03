#!/usr/bin/env bun
/** pi-stories — Blueprint Engine for AI Agent Orchestration */

import { Command } from "commander";
import chalk from "chalk";
import { initProject, isInitialized, loadConfig, findProjectRoot } from "./config.ts";
import { runPipeline } from "./pipeline/engine.ts";
import { buildDefaultPipeline } from "./pipeline/steps.ts";
import { detectGates } from "./pipeline/gates.ts";
import type { PipelineConfig } from "./types.ts";

const program = new Command();

program
	.name("pi-stories")
	.description("Multi-agent orchestration with Blueprint Engine [D]/[N] and cost routing")
	.version("0.1.0");

// ─── init ───────────────────────────────────────────────

program
	.command("init")
	.description("Initialize pi-stories in the current project")
	.action(async () => {
		const root = process.cwd();

		if (isInitialized(root)) {
			console.log(chalk.yellow("⚠ Already initialized in this project"));
			return;
		}

		const configDir = await initProject(root);

		// Auto-detect gates
		const gates = await detectGates(root);
		const detected = Object.entries(gates).filter(([_, v]) => v);

		console.log(chalk.green("✅ Initialized .pi-stories/"));
		console.log(`   Config: ${configDir}/config.yaml`);
		console.log(`   Runs:   ${configDir}/runs/`);

		if (detected.length > 0) {
			console.log(chalk.dim("\n   Auto-detected gates:"));
			for (const [name, cmd] of detected) {
				console.log(chalk.dim(`   ${name}: ${cmd}`));
			}
		}
	});

// ─── run ────────────────────────────────────────────────

program
	.command("run")
	.description("Execute Blueprint Engine pipeline on a task")
	.argument("<task>", "Task description (natural language)")
	.option("--budget <amount>", "Cost ceiling in dollars", "5.00")
	.option("--runtime <name>", "Force specific runtime")
	.option("--dry-run", "Show pipeline plan without executing")
	.option("--retry <n>", "Max retries per [N] step", "3")
	.option("--skip-review", "Skip the review phase")
	.action(async (task: string, opts) => {
		const root = findProjectRoot();

		if (!isInitialized(root)) {
			console.log(chalk.red("❌ Not initialized. Run: pi-stories init"));
			process.exit(1);
		}

		const config = await loadConfig(root);
		const budget = Number.parseFloat(opts.budget);
		const maxRetries = Number.parseInt(opts.retry, 10);

		console.log(chalk.bold("\n🎬 pi-stories run"));
		console.log(chalk.dim(`   Task: "${task}"`));
		console.log(chalk.dim(`   Budget: $${budget.toFixed(2)}`));
		console.log(chalk.dim(`   Retries: ${maxRetries}\n`));

		const steps = buildDefaultPipeline(config);
		const pipelineConfig: PipelineConfig = {
			steps: opts.skipReview ? steps.filter((s) => s.role !== "reviewer") : steps,
			maxRetries,
			budget,
		};

		const result = await runPipeline({
			task,
			config: pipelineConfig,
			cwd: root,
			dryRun: opts.dryRun,
			onStep: (step, res) => {
				const icon = res.status === "passed" ? chalk.green("✓") : chalk.red("✗");
				const kind = step.kind === "D" ? chalk.blue("[D]") : chalk.yellow("[N]");
				const cost = res.cost ? chalk.dim(` $${res.cost.cost.toFixed(4)}`) : "";
				console.log(`  ${icon} ${kind} ${step.name}${cost}`);
			},
		});

		// Summary
		console.log("\n" + "─".repeat(50));
		if (result.status === "passed") {
			console.log(chalk.green.bold("✅ Pipeline completed"));
		} else if (result.status === "skipped") {
			console.log(chalk.blue.bold("📋 Dry run complete"));
		} else {
			console.log(chalk.red.bold("❌ Pipeline failed"));
		}
		console.log(chalk.dim(`   Run ID: ${result.id}`));
		console.log(chalk.dim(`   Steps: ${result.steps.length}`));
		console.log(chalk.dim(`   Cost: $${result.totalCost.toFixed(4)}`));
		console.log(chalk.dim(`   Tokens: ${result.totalTokens.toLocaleString()}`));

		const duration = result.completedAt
			? (new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()) / 1000
			: 0;
		console.log(chalk.dim(`   Duration: ${duration.toFixed(1)}s`));

		process.exit(result.status === "passed" || result.status === "skipped" ? 0 : 1);
	});

// ─── status ─────────────────────────────────────────────

program
	.command("status")
	.description("Show active and recent runs")
	.action(async () => {
		const root = findProjectRoot();
		if (!isInitialized(root)) {
			console.log(chalk.red("❌ Not initialized. Run: pi-stories init"));
			return;
		}

		const configDir = `${root}/.pi-stories`;
		const runsDir = `${configDir}/runs`;

		try {
			const entries = await Array.fromAsync(new Bun.Glob("*/status.json").scan(runsDir));

			if (entries.length === 0) {
				console.log(chalk.dim("No runs yet. Start with: pi-stories run <task>"));
				return;
			}

			console.log(chalk.bold("\n📊 Recent runs\n"));

			const runs = [];
			for (const entry of entries) {
				try {
					const raw = await Bun.file(`${runsDir}/${entry}`).text();
					runs.push(JSON.parse(raw));
				} catch {
					// skip corrupt entries
				}
			}

			// Sort by start time, most recent first
			runs.sort(
				(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			);

			for (const run of runs.slice(0, 10)) {
				const icon = run.status === "passed" ? "✅" : run.status === "failed" ? "❌" : "⏳";
				const cost = `$${(run.totalCost ?? 0).toFixed(4)}`;
				const date = new Date(run.startedAt).toLocaleDateString();
				console.log(`  ${icon} ${run.id} ${chalk.dim(date)} ${cost} — ${run.task}`);
			}
		} catch {
			console.log(chalk.dim("No runs directory found."));
		}
	});

// ─── costs ──────────────────────────────────────────────

program
	.command("costs")
	.description("Token and cost breakdown")
	.option("--run <id>", "Show costs for specific run")
	.action(async (opts) => {
		const root = findProjectRoot();
		if (!isInitialized(root)) {
			console.log(chalk.red("❌ Not initialized."));
			return;
		}

		console.log(chalk.bold("\n💰 Cost Report\n"));

		const runsDir = `${root}/.pi-stories/runs`;
		const entries = await Array.fromAsync(new Bun.Glob("*/status.json").scan(runsDir));

		let totalSpent = 0;
		let totalTokens = 0;
		let runCount = 0;

		for (const entry of entries) {
			try {
				const raw = await Bun.file(`${runsDir}/${entry}`).text();
				const run = JSON.parse(raw);

				if (opts.run && !run.id.startsWith(opts.run)) continue;

				totalSpent += run.totalCost ?? 0;
				totalTokens += run.totalTokens ?? 0;
				runCount++;

				if (opts.run) {
					// Detailed view for single run
					console.log(`  Run: ${run.id}`);
					console.log(`  Task: ${run.task}`);
					console.log(`  Status: ${run.status}`);
					console.log("");

					for (const step of run.steps ?? []) {
						if (step.cost) {
							console.log(
								`  ${step.stepId}: ${step.cost.model ?? "unknown"} — $${step.cost.cost.toFixed(4)} (${step.cost.inputTokens + step.cost.outputTokens} tokens)`,
							);
						}
					}
				}
			} catch {
				// skip
			}
		}

		console.log(chalk.dim("─".repeat(40)));
		console.log(`  Runs: ${runCount}`);
		console.log(`  Total spent: ${chalk.bold(`$${totalSpent.toFixed(4)}`)}`);
		console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
		if (runCount > 0) {
			console.log(`  Avg per run: $${(totalSpent / runCount).toFixed(4)}`);
		}
	});

// ─── doctor ─────────────────────────────────────────────

program
	.command("doctor")
	.description("Health check — verify runtimes, config, and environment")
	.action(async () => {
		console.log(chalk.bold("\n🏥 pi-stories doctor\n"));

		const checks: { name: string; status: string; detail: string }[] = [];

		// Check: git
		try {
			const proc = Bun.spawn(["git", "--version"], { stdout: "pipe" });
			await proc.exited;
			const ver = (await new Response(proc.stdout).text()).trim();
			checks.push({ name: "git", status: "ok", detail: ver });
		} catch {
			checks.push({ name: "git", status: "fail", detail: "Not found" });
		}

		// Check: bun
		checks.push({ name: "bun", status: "ok", detail: `v${Bun.version}` });

		// Check: pi-stories initialized
		const root = findProjectRoot();
		checks.push({
			name: "initialized",
			status: isInitialized(root) ? "ok" : "warn",
			detail: isInitialized(root) ? `.pi-stories/ found` : "Not initialized",
		});

		// Check runtimes
		const runtimes = ["pi", "claude", "codex", "gemini"];
		for (const rt of runtimes) {
			try {
				const proc = Bun.spawn(["which", rt], { stdout: "pipe", stderr: "pipe" });
				const code = await proc.exited;
				const path = (await new Response(proc.stdout).text()).trim();
				checks.push({
					name: `runtime:${rt}`,
					status: code === 0 ? "ok" : "warn",
					detail: code === 0 ? path : "Not found",
				});
			} catch {
				checks.push({ name: `runtime:${rt}`, status: "warn", detail: "Not found" });
			}
		}

		// Print results
		for (const check of checks) {
			const icon =
				check.status === "ok" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
			console.log(`  ${icon} ${check.name.padEnd(20)} ${chalk.dim(check.detail)}`);
		}

		const failures = checks.filter((c) => c.status === "fail");
		console.log("");
		if (failures.length === 0) {
			console.log(chalk.green("  All checks passed!"));
		} else {
			console.log(chalk.red(`  ${failures.length} check(s) failed`));
		}
	});

program.parse();

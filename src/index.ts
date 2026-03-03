#!/usr/bin/env bun
/** pi-stories — Blueprint Engine for AI Agent Orchestration
 *  v0.4: Full 32-command CLI with [D]/[N] pipeline, cost routing,
 *  mail, sessions, merge queue, watchdog, dashboard, and more. */

import { Command } from "commander";
import chalk from "chalk";
import { initProject, isInitialized, loadConfig, findProjectRoot, getConfigDir } from "./config.ts";
import { runPipeline } from "./pipeline/engine.ts";
import { buildDefaultPipeline } from "./pipeline/steps.ts";
import { detectGates } from "./pipeline/gates.ts";
import { sendMail, checkMail, listMail, markRead, replyToMail, purgeMail, getMailStats } from "./mail/store.ts";
import { createSession, updateSession, getSession, listSessions, getActiveSessions, getSessionStats } from "./sessions/store.ts";
import { enqueue, getQueue, getPending, updateMergeStatus, attemptMerge, resolveConflicts } from "./merge/queue.ts";
import { discoverRuntimes, listRuntimes } from "./runtimes/registry.ts";
import { getCostSummary, getCostsByRun } from "./costs/store.ts";
import { readEvents } from "./logging/events.ts";
import { startWatchdog } from "./watchdog/daemon.ts";
import { runDoctor, printDoctorResults } from "./commands/doctor.ts";
import type { PipelineConfig, MailType, MailPriority } from "./types.ts";

const program = new Command();

program
	.name("pi-stories")
	.description("Multi-agent orchestration with Blueprint Engine [D]/[N] and cost routing")
	.version("0.4.0");

// ═══════════════════════════════════════════════════════════
// v0.1 — CORE
// ═══════════════════════════════════════════════════════════

program
	.command("init")
	.description("Initialize pi-stories in the current project")
	.option("-y, --yes", "Skip prompts")
	.action(async () => {
		const root = process.cwd();
		if (isInitialized(root)) {
			console.log(chalk.yellow("⚠ Already initialized"));
			return;
		}
		const configDir = await initProject(root);
		const gates = await detectGates(root);
		const detected = Object.entries(gates).filter(([_, v]) => v);

		console.log(chalk.green("✅ Initialized .pi-stories/"));
		console.log(`   Config: ${configDir}/config.yaml`);
		if (detected.length > 0) {
			console.log(chalk.dim("\n   Auto-detected gates:"));
			for (const [name, cmd] of detected) {
				console.log(chalk.dim(`   ${name}: ${cmd}`));
			}
		}
	});

program
	.command("run")
	.description("Execute Blueprint Engine [D]/[N] pipeline")
	.argument("<task>", "Task description")
	.option("--budget <amount>", "Cost ceiling in dollars", "5.00")
	.option("--runtime <name>", "Force runtime")
	.option("--dry-run", "Show plan only")
	.option("--retry <n>", "Max retries per [N] step", "3")
	.option("--skip-review", "Skip review phase")
	.action(async (task: string, opts) => {
		const root = findProjectRoot();
		requireInit(root);

		const config = await loadConfig(root);
		const budget = Number.parseFloat(opts.budget);
		const maxRetries = Number.parseInt(opts.retry, 10);

		console.log(chalk.bold("\n🎬 pi-stories run"));
		console.log(chalk.dim(`   Task: "${task}"`));
		console.log(chalk.dim(`   Budget: $${budget.toFixed(2)} | Retries: ${maxRetries}\n`));

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

		console.log("\n" + "─".repeat(50));
		const statusMsg = result.status === "passed" ? chalk.green.bold("✅ Completed")
			: result.status === "skipped" ? chalk.blue.bold("📋 Dry run")
			: chalk.red.bold("❌ Failed");
		console.log(`${statusMsg}  ${chalk.dim(`${result.id} | $${result.totalCost.toFixed(4)} | ${result.totalTokens} tokens`)}`);
		process.exit(result.status === "passed" || result.status === "skipped" ? 0 : 1);
	});

program
	.command("status")
	.description("Show active agents, recent runs, and system state")
	.option("--all", "Show all runs")
	.option("--json", "JSON output")
	.action(async (opts) => {
		const root = findProjectRoot();
		requireInit(root);
		const configDir = getConfigDir(root);

		console.log(chalk.bold("\n📊 pi-stories status\n"));

		// Active agents
		try {
			const active = getActiveSessions(configDir);
			if (active.length > 0) {
				console.log(chalk.bold("  Active agents:"));
				for (const s of active) {
					console.log(`    🤖 ${s.name} (${s.runtime}/${s.role}) — ${s.task.slice(0, 50)}`);
				}
				console.log("");
			}
		} catch { /* sessions db may not exist yet */ }

		// Mail
		try {
			const mail = getMailStats(configDir);
			if (mail.total > 0) {
				console.log(`  📬 Mail: ${mail.unread} unread / ${mail.total} total`);
			}
		} catch { /* */ }

		// Merge queue
		try {
			const pending = getPending(configDir);
			if (pending.length > 0) {
				console.log(`  🔀 Merge queue: ${pending.length} pending`);
			}
		} catch { /* */ }

		// Recent runs
		const runsDir = `${configDir}/runs`;
		try {
			const entries = await Array.fromAsync(new Bun.Glob("*/status.json").scan(runsDir));
			if (entries.length > 0) {
				const runs = [];
				for (const entry of entries) {
					try { runs.push(JSON.parse(await Bun.file(`${runsDir}/${entry}`).text())); } catch { /* */ }
				}
				runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

				console.log(chalk.bold("\n  Recent runs:"));
				for (const run of runs.slice(0, opts.all ? 50 : 5)) {
					const icon = run.status === "passed" ? "✅" : run.status === "failed" ? "❌" : "⏳";
					console.log(`    ${icon} ${run.id} $${(run.totalCost ?? 0).toFixed(4)} — ${run.task}`);
				}
			}
		} catch { /* */ }
	});

// ═══════════════════════════════════════════════════════════
// v0.2 — OBSERVABILITY
// ═══════════════════════════════════════════════════════════

program
	.command("costs")
	.description("Token and cost breakdown")
	.option("--run <id>", "Costs for specific run")
	.option("--live", "Show real-time costs for active agents")
	.option("--by-tier", "Group by cost tier")
	.option("--by-runtime", "Group by runtime")
	.action(async (opts) => {
		const root = findProjectRoot();
		requireInit(root);
		const configDir = getConfigDir(root);

		console.log(chalk.bold("\n💰 Cost Report\n"));

		try {
			const summary = getCostSummary(configDir);

			console.log(`  Today:    ${chalk.bold(`$${summary.today.toFixed(4)}`)}`);
			console.log(`  This week: $${summary.week.toFixed(4)}`);
			console.log(`  All time:  $${summary.total.toFixed(4)}`);

			if (opts.byTier) {
				console.log(chalk.bold("\n  By tier:"));
				console.log(`    Tier 1 (Haiku):  $${summary.byTier[1].toFixed(4)}`);
				console.log(`    Tier 2 (Sonnet): $${summary.byTier[2].toFixed(4)}`);
				console.log(`    Tier 3 (Opus):   $${summary.byTier[3].toFixed(4)}`);
			}

			if (opts.byRuntime) {
				console.log(chalk.bold("\n  By runtime:"));
				for (const [rt, cost] of Object.entries(summary.byRuntime)) {
					console.log(`    ${rt}: $${cost.toFixed(4)}`);
				}
			}

			if (opts.run) {
				const entries = getCostsByRun(configDir, opts.run);
				console.log(chalk.bold(`\n  Run ${opts.run}:`));
				for (const e of entries) {
					console.log(`    ${e.model} — $${e.cost.toFixed(4)} (${e.inputTokens + e.outputTokens} tokens)`);
				}
			}
		} catch {
			console.log(chalk.dim("  No cost data yet."));
		}
	});

program
	.command("trace")
	.description("Chronological event timeline for a run")
	.argument("<run-id>", "Run ID")
	.option("--limit <n>", "Max events", "100")
	.action(async (runId: string, opts) => {
		const root = findProjectRoot();
		const configDir = getConfigDir(root);
		const runDir = `${configDir}/runs/${runId}`;

		const events = await readEvents(runDir);
		const limit = Number.parseInt(opts.limit, 10);

		console.log(chalk.bold(`\n📍 Trace: ${runId}\n`));

		for (const event of events.slice(0, limit)) {
			const time = new Date(event.timestamp).toLocaleTimeString();
			const step = event.stepId ? chalk.cyan(`[${event.stepId}]`) : "";
			const cost = event.data?.cost ? chalk.dim(` $${Number(event.data.cost).toFixed(4)}`) : "";
			console.log(`  ${chalk.dim(time)} ${step} ${event.type}${cost}`);
		}

		if (events.length > limit) {
			console.log(chalk.dim(`\n  ... ${events.length - limit} more events`));
		}
	});

program
	.command("replay")
	.description("Replay agent actions chronologically")
	.argument("<run-id>", "Run ID")
	.option("--speed <x>", "Playback speed multiplier", "1")
	.action(async (runId: string, opts) => {
		const root = findProjectRoot();
		const configDir = getConfigDir(root);
		const runDir = `${configDir}/runs/${runId}`;

		const events = await readEvents(runDir);
		const speed = Number.parseFloat(opts.speed);

		console.log(chalk.bold(`\n🎬 Replay: ${runId} (${speed}x)\n`));

		let prevTime: number | null = null;

		for (const event of events) {
			const eventTime = new Date(event.timestamp).getTime();
			if (prevTime !== null) {
				const delay = Math.max(0, (eventTime - prevTime) / speed);
				if (delay > 0 && delay < 10000) {
					await new Promise((r) => setTimeout(r, delay));
				}
			}
			prevTime = eventTime;

			const time = new Date(event.timestamp).toLocaleTimeString();
			const step = event.stepId ? chalk.cyan(`[${event.stepId}]`) : "";
			console.log(`  ${chalk.dim(time)} ${step} ${event.type}`);
		}
	});

program
	.command("logs")
	.description("Query NDJSON event logs")
	.option("--run <id>", "Filter by run")
	.option("--type <type>", "Filter by event type")
	.option("--limit <n>", "Max entries", "50")
	.action(async (opts) => {
		const root = findProjectRoot();
		const configDir = getConfigDir(root);
		const runsDir = `${configDir}/runs`;

		const limit = Number.parseInt(opts.limit, 10);
		const allEvents = [];

		const entries = await Array.fromAsync(new Bun.Glob("*/events.jsonl").scan(runsDir));
		for (const entry of entries) {
			if (opts.run && !entry.startsWith(opts.run)) continue;
			const events = await readEvents(`${runsDir}/${entry.split("/")[0]}`);
			allEvents.push(...events);
		}

		allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		let filtered = allEvents;
		if (opts.type) filtered = filtered.filter((e) => e.type.includes(opts.type));

		console.log(chalk.bold(`\n📋 Logs (${Math.min(filtered.length, limit)} of ${filtered.length})\n`));

		for (const event of filtered.slice(0, limit)) {
			const time = new Date(event.timestamp).toLocaleTimeString();
			console.log(`  ${chalk.dim(time)} ${event.runId} ${event.type} ${event.stepId ?? ""}`);
		}
	});

program
	.command("dashboard")
	.description("Live TUI dashboard")
	.option("--interval <ms>", "Refresh interval", "3000")
	.action(async (opts) => {
		const root = findProjectRoot();
		requireInit(root);
		const configDir = getConfigDir(root);
		const interval = Number.parseInt(opts.interval, 10);

		const refresh = async () => {
			console.clear();
			console.log(chalk.bold("┌─────────────────────────────────────────┐"));
			console.log(chalk.bold("│  🎬 pi-stories dashboard                │"));
			console.log(chalk.bold("└─────────────────────────────────────────┘\n"));

			try {
				const sessionStats = getSessionStats(configDir);
				console.log(`  Agents: ${chalk.green(String(sessionStats.active))} active, ${sessionStats.completed} done, ${sessionStats.failed} failed`);
				console.log(`  Cost: $${sessionStats.totalCost.toFixed(4)} | ${sessionStats.totalTokens.toLocaleString()} tokens`);
			} catch { /* */ }

			try {
				const mail = getMailStats(configDir);
				console.log(`  Mail: ${mail.unread} unread / ${mail.total} total`);
			} catch { /* */ }

			try {
				const pending = getPending(configDir);
				console.log(`  Merge: ${pending.length} pending`);
			} catch { /* */ }

			try {
				const active = getActiveSessions(configDir);
				if (active.length > 0) {
					console.log(chalk.bold("\n  Active:"));
					for (const s of active) {
						const dur = ((Date.now() - new Date(s.startedAt).getTime()) / 1000).toFixed(0);
						console.log(`    🤖 ${s.name.padEnd(16)} ${s.runtime.padEnd(8)} ${s.role.padEnd(10)} ${dur}s  $${s.cost.toFixed(4)}`);
					}
				}
			} catch { /* */ }

			console.log(chalk.dim(`\n  Refreshing every ${interval / 1000}s — Ctrl+C to exit`));
		};

		await refresh();
		setInterval(refresh, interval);
	});

// ═══════════════════════════════════════════════════════════
// v0.3 — MULTI-AGENT
// ═══════════════════════════════════════════════════════════

program
	.command("sling")
	.description("Spawn a single agent")
	.argument("<task>", "Task for the agent")
	.option("--name <name>", "Agent name")
	.option("--runtime <rt>", "Runtime to use", "pi")
	.option("--role <role>", "Agent role", "builder")
	.option("--run-id <id>", "Associate with a run")
	.option("--depth <n>", "Hierarchy depth", "0")
	.action(async (task: string, opts) => {
		const root = findProjectRoot();
		requireInit(root);
		const configDir = getConfigDir(root);

		const name = opts.name ?? `${opts.role}-${Date.now().toString(36)}`;

		console.log(chalk.bold(`\n🚀 Slinging agent: ${name}`));
		console.log(chalk.dim(`   Runtime: ${opts.runtime} | Role: ${opts.role}\n`));

		const session = createSession(configDir, {
			name,
			runtime: opts.runtime,
			role: opts.role,
			task,
			runId: opts.runId,
			depth: Number.parseInt(opts.depth, 10),
		});

		// Spawn the agent
		const proc = Bun.spawn([opts.runtime, "--print", task], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});

		updateSession(configDir, session.id, { pid: proc.pid });
		console.log(`  Agent ${name} spawned (PID: ${proc.pid})`);

		const exitCode = await proc.exited;
		const output = await new Response(proc.stdout).text();

		updateSession(configDir, session.id, {
			status: exitCode === 0 ? "completed" : "failed",
		});

		console.log(`\n  ${exitCode === 0 ? "✅" : "❌"} Agent ${name} ${exitCode === 0 ? "completed" : "failed"}`);
		if (output.trim()) {
			console.log(chalk.dim(`\n${output.slice(0, 500)}`));
		}
	});

const mailCmd = program.command("mail").description("Inter-agent messaging");

mailCmd
	.command("send")
	.description("Send a message")
	.requiredOption("--to <agent>", "Recipient")
	.requiredOption("--subject <text>", "Subject")
	.requiredOption("--body <text>", "Message body")
	.option("--from <name>", "Sender", "orchestrator")
	.option("--type <type>", "Message type", "status")
	.option("--priority <p>", "Priority", "normal")
	.action(async (opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const msg = sendMail(configDir, {
			from: opts.from,
			to: opts.to,
			subject: opts.subject,
			body: opts.body,
			type: opts.type as MailType,
			priority: opts.priority as MailPriority,
		});
		console.log(chalk.green(`✉ Sent: ${msg.id} → ${opts.to}`));
	});

mailCmd
	.command("check")
	.description("Check inbox")
	.option("--agent <name>", "Agent name", "orchestrator")
	.action(async (opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const messages = checkMail(configDir, opts.agent);
		if (messages.length === 0) {
			console.log(chalk.dim("No unread messages."));
			return;
		}
		console.log(chalk.bold(`\n📬 ${messages.length} unread message(s)\n`));
		for (const m of messages) {
			const pri = m.priority === "urgent" ? chalk.red("‼") : m.priority === "high" ? chalk.yellow("!") : " ";
			console.log(`  ${pri} ${m.id} from:${m.from} — ${m.subject}`);
			console.log(chalk.dim(`    ${m.body.slice(0, 100)}`));
		}
	});

mailCmd
	.command("list")
	.description("List messages")
	.option("--from <name>", "Filter by sender")
	.option("--to <name>", "Filter by recipient")
	.option("--unread", "Only unread")
	.action(async (opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const messages = listMail(configDir, opts);
		console.log(chalk.bold(`\n📋 ${messages.length} message(s)\n`));
		for (const m of messages) {
			const read = m.read ? chalk.dim("·") : chalk.green("●");
			console.log(`  ${read} ${m.id} ${m.from} → ${m.to}: ${m.subject}`);
		}
	});

mailCmd
	.command("read")
	.description("Mark message as read")
	.argument("<id>", "Message ID")
	.action(async (id: string) => {
		const configDir = getConfigDir(findProjectRoot());
		markRead(configDir, id);
		console.log(chalk.dim(`Marked ${id} as read.`));
	});

mailCmd
	.command("reply")
	.description("Reply to a message")
	.argument("<id>", "Original message ID")
	.requiredOption("--body <text>", "Reply body")
	.option("--from <name>", "Sender", "orchestrator")
	.action(async (id: string, opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const reply = replyToMail(configDir, id, opts.from, opts.body);
		console.log(chalk.green(`↩ Reply sent: ${reply.id}`));
	});

mailCmd
	.command("purge")
	.description("Delete old messages")
	.option("--all", "Delete everything")
	.option("--days <n>", "Delete older than N days")
	.option("--agent <name>", "Delete for specific agent")
	.action(async (opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const count = purgeMail(configDir, {
			all: opts.all,
			days: opts.days ? Number.parseInt(opts.days, 10) : undefined,
			agent: opts.agent,
		});
		console.log(chalk.dim(`Purged ${count} message(s).`));
	});

program
	.command("merge")
	.description("Merge agent branches")
	.option("--branch <name>", "Specific branch")
	.option("--all", "All pending branches")
	.option("--into <branch>", "Target branch", "main")
	.option("--dry-run", "Check conflicts only")
	.action(async (opts) => {
		const root = findProjectRoot();
		requireInit(root);
		const configDir = getConfigDir(root);

		const pending = getPending(configDir);
		const toMerge = opts.branch
			? pending.filter((e) => e.branch === opts.branch)
			: opts.all
			  ? pending
			  : pending.slice(0, 1);

		if (toMerge.length === 0) {
			console.log(chalk.dim("Nothing to merge."));
			return;
		}

		console.log(chalk.bold(`\n🔀 Merging ${toMerge.length} branch(es) into ${opts.into}\n`));

		for (const entry of toMerge) {
			if (opts.dryRun) {
				const result = await attemptMerge(root, entry.branch, opts.into);
				const icon = result.success ? chalk.green("✓") : chalk.red("✗");
				console.log(`  ${icon} ${entry.branch} — ${result.success ? "clean" : `${result.conflictFiles.length} conflicts`}`);
				continue;
			}

			const result = await resolveConflicts(root, entry.branch, opts.into, 3);
			if (result.success) {
				updateMergeStatus(configDir, entry.id, "merged");
				console.log(chalk.green(`  ✓ ${entry.branch} merged (tier ${result.tier})`));
			} else {
				updateMergeStatus(configDir, entry.id, "conflict", result.files, result.tier);
				console.log(chalk.red(`  ✗ ${entry.branch} — ${result.files.length} conflicts (tier ${result.tier})`));
			}
		}
	});

program
	.command("nudge")
	.description("Poke a stalled agent")
	.argument("<agent>", "Agent name")
	.argument("[message]", "Optional nudge message")
	.action(async (agent: string, message?: string) => {
		const configDir = getConfigDir(findProjectRoot());
		sendMail(configDir, {
			from: "orchestrator",
			to: agent,
			subject: "Nudge: status update needed",
			body: message ?? "Are you still working? Please report progress.",
			type: "nudge",
			priority: "high",
		});
		console.log(chalk.yellow(`👉 Nudged ${agent}`));
	});

program
	.command("stop")
	.description("Terminate an agent")
	.argument("<agent>", "Agent name or ID")
	.action(async (agent: string) => {
		const configDir = getConfigDir(findProjectRoot());
		const session = getSession(configDir, agent);
		if (!session) {
			console.log(chalk.red(`Agent "${agent}" not found.`));
			return;
		}
		if (session.pid) {
			try { process.kill(session.pid, "SIGTERM"); } catch { /* */ }
		}
		updateSession(configDir, session.id, { status: "killed" });
		console.log(chalk.red(`⏹ Stopped ${session.name} (PID: ${session.pid})`));
	});

// ═══════════════════════════════════════════════════════════
// v0.4 — FULL PARITY + BEYOND
// ═══════════════════════════════════════════════════════════

program
	.command("doctor")
	.description("11-category health check")
	.option("--category <name>", "Run one category only")
	.option("--verbose", "Show passing checks")
	.option("--fix", "Auto-fix fixable issues")
	.action(async (opts) => {
		const results = await runDoctor(opts);
		printDoctorResults(results, opts.verbose);
	});

program
	.command("watch")
	.description("Start watchdog daemon")
	.option("--interval <ms>", "Check interval", "30000")
	.option("--stall <ms>", "Stall threshold", "300000")
	.option("--cost-ceiling <amount>", "Daily cost ceiling", "50")
	.option("--background", "Run in background")
	.action(async (opts) => {
		await startWatchdog(findProjectRoot(), {
			interval: Number.parseInt(opts.interval, 10),
			stallThreshold: Number.parseInt(opts.stall, 10),
			costCeiling: Number.parseFloat(opts.costCeiling),
		}, { background: opts.background });
	});

program
	.command("agents")
	.description("List available agent runtimes")
	.action(async () => {
		console.log(chalk.bold("\n🤖 Available runtimes\n"));
		const runtimes = await discoverRuntimes();
		for (const rt of runtimes) {
			const icon = rt.available ? chalk.green("✓") : chalk.red("✗");
			console.log(`  ${icon} ${rt.name.padEnd(16)} ${chalk.dim(rt.path ?? "not found")}`);
		}
		const available = runtimes.filter((r) => r.available).length;
		console.log(chalk.dim(`\n  ${available}/${runtimes.length} runtimes available`));
	});

program
	.command("clean")
	.description("Clean runtime state")
	.option("--all", "Wipe everything")
	.option("--runs", "Clean run data")
	.option("--mail", "Clean mail")
	.option("--sessions", "Clean sessions")
	.option("--days <n>", "Only clean older than N days")
	.action(async (opts) => {
		const configDir = getConfigDir(findProjectRoot());
		let cleaned = 0;

		if (opts.all || opts.mail) {
			const count = purgeMail(configDir, { all: true });
			cleaned += count;
			console.log(chalk.dim(`Purged ${count} mail messages.`));
		}

		if (opts.all || opts.runs) {
			// Clean run directories
			const runsDir = `${configDir}/runs`;
			try {
				const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: runsDir, onlyFiles: false }));
				for (const entry of entries) {
					const { rmSync } = require("node:fs");
					rmSync(`${runsDir}/${entry}`, { recursive: true, force: true });
					cleaned++;
				}
				console.log(chalk.dim(`Removed ${entries.length} run directories.`));
			} catch { /* */ }
		}

		console.log(chalk.dim(`\nCleaned ${cleaned} items.`));
	});

program
	.command("config")
	.description("View current configuration")
	.action(async () => {
		const root = findProjectRoot();
		requireInit(root);
		const config = await loadConfig(root);
		console.log(chalk.bold("\n⚙ Configuration\n"));
		console.log(JSON.stringify(config, null, 2));
	});

program
	.command("export")
	.description("Export a run as a shareable report")
	.argument("<run-id>", "Run ID")
	.option("--format <fmt>", "Output format", "json")
	.action(async (runId: string, opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const runDir = `${configDir}/runs/${runId}`;

		try {
			const status = JSON.parse(await Bun.file(`${runDir}/status.json`).text());
			const events = await readEvents(runDir);

			const report = {
				...status,
				events,
				exportedAt: new Date().toISOString(),
				version: "0.4.0",
			};

			if (opts.format === "json") {
				const outFile = `pi-stories-${runId}.json`;
				await Bun.write(outFile, JSON.stringify(report, null, 2));
				console.log(chalk.green(`📄 Exported to ${outFile}`));
			}
		} catch {
			console.log(chalk.red(`Run ${runId} not found.`));
		}
	});

program
	.command("queue")
	.description("Show merge queue")
	.action(async () => {
		const configDir = getConfigDir(findProjectRoot());
		const queue = getQueue(configDir);
		if (queue.length === 0) {
			console.log(chalk.dim("Merge queue is empty."));
			return;
		}
		console.log(chalk.bold(`\n🔀 Merge queue (${queue.length})\n`));
		for (const entry of queue) {
			const icon = entry.status === "merged" ? "✅" : entry.status === "conflict" ? "⚠️" : "⏳";
			console.log(`  ${icon} ${entry.id} ${entry.branch} (${entry.agentName}) — ${entry.status}`);
		}
	});

program
	.command("sessions")
	.description("List agent sessions")
	.option("--active", "Only active sessions")
	.option("--run <id>", "Filter by run")
	.action(async (opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const sessions = opts.active
			? getActiveSessions(configDir)
			: listSessions(configDir, { runId: opts.run });

		if (sessions.length === 0) {
			console.log(chalk.dim("No sessions found."));
			return;
		}

		console.log(chalk.bold(`\n👥 Sessions (${sessions.length})\n`));
		for (const s of sessions) {
			const icon = s.status === "running" ? "🟢" : s.status === "completed" ? "✅" : s.status === "failed" ? "❌" : "⚪";
			console.log(`  ${icon} ${s.name.padEnd(20)} ${s.runtime.padEnd(8)} ${s.role.padEnd(10)} $${s.cost.toFixed(4)}`);
		}
	});

program
	.command("inspect")
	.description("Deep inspection of a single agent")
	.argument("<agent>", "Agent name or ID")
	.action(async (agent: string) => {
		const configDir = getConfigDir(findProjectRoot());
		const session = getSession(configDir, agent);
		if (!session) {
			console.log(chalk.red(`Agent "${agent}" not found.`));
			return;
		}
		console.log(chalk.bold(`\n🔍 Agent: ${session.name}\n`));
		console.log(`  ID:       ${session.id}`);
		console.log(`  Runtime:  ${session.runtime}`);
		console.log(`  Role:     ${session.role}`);
		console.log(`  Status:   ${session.status}`);
		console.log(`  Task:     ${session.task}`);
		console.log(`  PID:      ${session.pid ?? "n/a"}`);
		console.log(`  Depth:    ${session.depth}`);
		console.log(`  Tokens:   ${session.tokenCount.toLocaleString()}`);
		console.log(`  Cost:     $${session.cost.toFixed(4)}`);
		console.log(`  Started:  ${session.startedAt}`);
		console.log(`  Activity: ${session.lastActivityAt}`);
		if (session.branch) console.log(`  Branch:   ${session.branch}`);
		if (session.worktree) console.log(`  Worktree: ${session.worktree}`);
	});

program
	.command("monitor")
	.description("Real-time agent output stream")
	.argument("<agent>", "Agent name or ID")
	.option("--tail <n>", "Tail last N lines", "50")
	.action(async (agent: string, opts) => {
		const configDir = getConfigDir(findProjectRoot());
		const session = getSession(configDir, agent);
		if (!session) {
			console.log(chalk.red(`Agent "${agent}" not found.`));
			return;
		}
		console.log(chalk.bold(`\n📡 Monitoring: ${session.name} (${session.runtime}/${session.role})\n`));
		console.log(chalk.dim(`PID: ${session.pid} | Status: ${session.status} | Cost: $${session.cost.toFixed(4)}`));
		console.log(chalk.dim("─".repeat(50)));

		if (session.status !== "running") {
			console.log(chalk.yellow(`\nAgent is ${session.status}. No live output.`));
			return;
		}

		// Poll for activity updates
		console.log(chalk.dim("\nPolling for activity... Ctrl+C to stop\n"));
		const poll = setInterval(async () => {
			const current = getSession(configDir, agent);
			if (!current || current.status !== "running") {
				console.log(chalk.dim(`\nAgent ${session.name} is now ${current?.status ?? "gone"}.`));
				clearInterval(poll);
			}
		}, 5000);
	});

program
	.command("worktree")
	.description("Manage git worktrees for parallel agents")
	.argument("<action>", "create | list | remove")
	.option("--branch <name>", "Branch name for create")
	.option("--agent <name>", "Associate with agent")
	.action(async (action: string, opts) => {
		const root = findProjectRoot();

		switch (action) {
			case "list": {
				const proc = Bun.spawn(["git", "worktree", "list"], { cwd: root, stdout: "pipe" });
				await proc.exited;
				const output = await new Response(proc.stdout).text();
				console.log(chalk.bold("\n🌳 Git worktrees\n"));
				console.log(output);
				break;
			}
			case "create": {
				if (!opts.branch) {
					console.log(chalk.red("--branch required for create"));
					return;
				}
				const wtDir = `${root}/.pi-stories/worktrees/${opts.branch}`;
				const proc = Bun.spawn(["git", "worktree", "add", wtDir, "-b", opts.branch], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				const code = await proc.exited;
				if (code === 0) {
					console.log(chalk.green(`✅ Created worktree at ${wtDir}`));
					if (opts.agent) {
						const configDir = getConfigDir(root);
						const session = getSession(configDir, opts.agent);
						if (session) {
							updateSession(configDir, session.id, {});
							console.log(chalk.dim(`   Associated with agent: ${opts.agent}`));
						}
					}
				} else {
					const stderr = await new Response(proc.stderr).text();
					console.log(chalk.red(`Failed: ${stderr}`));
				}
				break;
			}
			case "remove": {
				if (!opts.branch) {
					console.log(chalk.red("--branch required for remove"));
					return;
				}
				const wtDir = `${root}/.pi-stories/worktrees/${opts.branch}`;
				const proc = Bun.spawn(["git", "worktree", "remove", wtDir, "--force"], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				const code = await proc.exited;
				if (code === 0) {
					console.log(chalk.green(`🗑 Removed worktree: ${opts.branch}`));
				} else {
					const stderr = await new Response(proc.stderr).text();
					console.log(chalk.red(`Failed: ${stderr}`));
				}
				break;
			}
			default:
				console.log(chalk.red(`Unknown action: ${action}. Use: create | list | remove`));
		}
	});

program
	.command("parallel")
	.description("Run multiple agents in parallel on the same task or different sub-tasks")
	.argument("<task>", "Task description")
	.option("--agents <n>", "Number of agents", "3")
	.option("--runtime <rt>", "Runtime to use", "pi")
	.option("--roles <roles>", "Comma-separated roles", "scout,builder,reviewer")
	.action(async (task: string, opts) => {
		const root = findProjectRoot();
		requireInit(root);
		const configDir = getConfigDir(root);

		const n = Number.parseInt(opts.agents, 10);
		const roles = opts.roles.split(",");

		console.log(chalk.bold(`\n⚡ Parallel launch: ${n} agents\n`));

		const sessions = [];
		for (let i = 0; i < n; i++) {
			const role = roles[i % roles.length];
			const name = `${role}-${Date.now().toString(36)}-${i}`;

			const session = createSession(configDir, {
				name,
				runtime: opts.runtime,
				role: role as any,
				task: `[${role}] ${task}`,
				depth: 0,
			});

			const proc = Bun.spawn([opts.runtime, "--print", `[${role}] ${task}`], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
			});

			updateSession(configDir, session.id, { pid: proc.pid });
			sessions.push({ session, proc, name });
			console.log(`  🚀 ${name} (PID: ${proc.pid})`);
		}

		console.log(chalk.dim("\n  Waiting for all agents to complete...\n"));

		const results = await Promise.allSettled(
			sessions.map(async ({ session, proc, name }) => {
				const code = await proc.exited;
				updateSession(configDir, session.id, {
					status: code === 0 ? "completed" : "failed",
				});
				const icon = code === 0 ? chalk.green("✓") : chalk.red("✗");
				console.log(`  ${icon} ${name} — exit ${code}`);
				return code;
			}),
		);

		const passed = results.filter((r) => r.status === "fulfilled" && r.value === 0).length;
		console.log(chalk.dim(`\n  ${passed}/${n} agents succeeded`));
	});

program
	.command("version")
	.description("Show version and build info")
	.action(() => {
		console.log(chalk.bold("pi-stories v0.4.0"));
		console.log(chalk.dim(`Bun ${Bun.version} | ${process.platform} | ${process.arch}`));
		console.log(chalk.dim(`Node compat: ${process.version}`));
	});

// ═══════════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════════

function requireInit(root: string): void {
	if (!isInitialized(root)) {
		console.log(chalk.red("❌ Not initialized. Run: pi-stories init"));
		process.exit(1);
	}
}

program.parse();

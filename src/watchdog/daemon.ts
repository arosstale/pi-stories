/** Watchdog daemon — monitor agent health, detect stalls, enforce limits */

import chalk from "chalk";
import { getConfigDir } from "../config.ts";
import { getActiveSessions, findStalledSessions, updateSession } from "../sessions/store.ts";
import { getCostSummary } from "../costs/store.ts";
import { sendMail } from "../mail/store.ts";
import type { WatchdogConfig, AgentSession } from "../types.ts";

const DEFAULT_CONFIG: WatchdogConfig = {
	interval: 30000, // 30s
	stallThreshold: 300000, // 5 min
	maxRestarts: 3,
	costCeiling: 50.0,
};

/** Start the watchdog daemon */
export async function startWatchdog(
	cwd: string,
	config?: Partial<WatchdogConfig>,
	opts?: { background?: boolean },
): Promise<void> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const configDir = getConfigDir(cwd);

	console.log(chalk.bold("🐕 Watchdog started"));
	console.log(chalk.dim(`   Interval: ${cfg.interval / 1000}s`));
	console.log(chalk.dim(`   Stall threshold: ${cfg.stallThreshold / 1000}s`));
	console.log(chalk.dim(`   Cost ceiling: $${cfg.costCeiling}`));
	console.log("");

	const restartCounts = new Map<string, number>();

	const tick = async () => {
		try {
			// Check for stalled agents
			const stalled = findStalledSessions(configDir, cfg.stallThreshold);
			for (const session of stalled) {
				const restarts = restartCounts.get(session.id) ?? 0;

				if (restarts >= cfg.maxRestarts) {
					console.log(chalk.red(`  ✗ ${session.name}: stalled, max restarts reached — killing`));
					updateSession(configDir, session.id, { status: "killed" });
					if (session.pid) {
						try { process.kill(session.pid, "SIGTERM"); } catch { /* */ }
					}
					sendMail(configDir, {
						from: "watchdog",
						to: "orchestrator",
						subject: `Agent killed: ${session.name}`,
						body: `Agent ${session.name} was killed after ${cfg.maxRestarts} restart attempts. Last activity: ${session.lastActivityAt}`,
						type: "error",
						priority: "high",
					});
				} else {
					console.log(chalk.yellow(`  ⚠ ${session.name}: stalled (${restarts + 1}/${cfg.maxRestarts} restarts)`));
					restartCounts.set(session.id, restarts + 1);

					sendMail(configDir, {
						from: "watchdog",
						to: session.name,
						subject: "Nudge: are you still working?",
						body: `You haven't reported activity in ${cfg.stallThreshold / 1000}s. Please update your status.`,
						type: "nudge",
						priority: "high",
					});
				}
			}

			// Check cost ceiling
			const costs = getCostSummary(configDir);
			if (costs.today > cfg.costCeiling) {
				console.log(chalk.red(`  💸 Cost ceiling breached: $${costs.today.toFixed(2)} > $${cfg.costCeiling}`));

				// Kill all running agents
				const active = getActiveSessions(configDir);
				for (const session of active) {
					updateSession(configDir, session.id, { status: "killed" });
					if (session.pid) {
						try { process.kill(session.pid, "SIGTERM"); } catch { /* */ }
					}
				}

				sendMail(configDir, {
					from: "watchdog",
					to: "orchestrator",
					subject: "COST CEILING BREACHED",
					body: `Daily spend $${costs.today.toFixed(2)} exceeded ceiling $${cfg.costCeiling}. All agents killed.`,
					type: "error",
					priority: "urgent",
				});
			}

			// Report active agents
			const active = getActiveSessions(configDir);
			if (active.length > 0) {
				const names = active.map((a) => a.name).join(", ");
				console.log(chalk.dim(`  · ${active.length} active: ${names}`));
			}
		} catch (err) {
			console.error(chalk.red(`  Watchdog error: ${err}`));
		}
	};

	// Run immediately, then on interval
	await tick();
	setInterval(tick, cfg.interval);
}

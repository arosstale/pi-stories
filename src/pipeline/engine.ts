/** Blueprint Engine — the [D]/[N] pipeline orchestrator */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BudgetExceededError, GateError, PipelineError } from "../errors.ts";
import type {
	PipelineConfig,
	PipelineEvent,
	PipelineStep,
	ProjectConfig,
	RunState,
	StepResult,
	CostEntry,
} from "../types.ts";
import { getConfigDir } from "../config.ts";
import { runGate } from "./gates.ts";
import { runAgent } from "./agent.ts";
import { emitEvent, flushEvents } from "../logging/events.ts";

export interface EngineOptions {
	task: string;
	config: PipelineConfig;
	projectConfig?: ProjectConfig;
	cwd: string;
	dryRun?: boolean;
	onStep?: (step: PipelineStep, result: StepResult) => void;
}

/** Execute the full [D]/[N] pipeline */
export async function runPipeline(opts: EngineOptions): Promise<RunState> {
	const runId = randomUUID().slice(0, 8);
	const runDir = join(getConfigDir(opts.cwd), "runs", runId);
	await mkdir(runDir, { recursive: true });

	const state: RunState = {
		id: runId,
		task: opts.task,
		startedAt: new Date().toISOString(),
		status: "running",
		steps: [],
		totalCost: 0,
		totalTokens: 0,
	};

	await emitEvent({
		timestamp: state.startedAt,
		runId,
		type: "run:start",
		data: { task: opts.task },
	});

	if (opts.dryRun) {
		console.log(`\n🔍 Dry run — pipeline plan for: "${opts.task}"\n`);
		for (const step of opts.config.steps) {
			const icon = step.kind === "D" ? "🔧" : "🤖";
			const tier = step.tier ? ` (tier ${step.tier})` : "";
			console.log(`  ${icon} [${step.kind}] ${step.name}${tier}`);
		}
		console.log(`\n  Budget: $${opts.config.budget.toFixed(2)}`);
		console.log(`  Max retries: ${opts.config.maxRetries}`);
		state.status = "skipped";
		return state;
	}

	try {
		for (const step of opts.config.steps) {
			const result = await executeStep(step, state, opts, runDir);
			state.steps.push(result);

			if (result.cost) {
				state.totalCost += result.cost.cost;
				state.totalTokens += result.cost.inputTokens + result.cost.outputTokens;
			}

			opts.onStep?.(step, result);

			if (result.status === "failed") {
				state.status = "failed";
				break;
			}

			// Budget check after every [N] step
			if (step.kind === "N" && state.totalCost > opts.config.budget) {
				throw new BudgetExceededError(state.totalCost, opts.config.budget);
			}
		}

		if (state.status === "running") {
			state.status = "passed";
		}
	} catch (err) {
		state.status = "failed";
		if (err instanceof BudgetExceededError) {
			console.error(`\n💸 ${err.message}`);
		}
	}

	state.completedAt = new Date().toISOString();

	await emitEvent({
		timestamp: state.completedAt,
		runId,
		type: state.status === "passed" ? "run:complete" : "run:fail",
		data: { totalCost: state.totalCost, totalTokens: state.totalTokens },
	});

	// Persist final state
	await writeFile(join(runDir, "status.json"), JSON.stringify(state, null, 2));
	await flushEvents(runDir);

	return state;
}

/** Execute a single pipeline step with retry logic */
async function executeStep(
	step: PipelineStep,
	state: RunState,
	opts: EngineOptions,
	runDir: string,
): Promise<StepResult> {
	const result: StepResult = {
		stepId: step.id,
		status: "running",
		startedAt: new Date().toISOString(),
		retryCount: 0,
	};

	await emitEvent({
		timestamp: result.startedAt,
		runId: state.id,
		type: "step:start",
		stepId: step.id,
		data: { kind: step.kind, name: step.name },
	});

	if (step.kind === "D") {
		// Deterministic step — run gate commands
		try {
			const output = await runGate(step, opts.cwd);
			result.status = "passed";
			result.output = output;
		} catch (err) {
			result.status = "failed";
			result.error = err instanceof Error ? err.message : String(err);
		}
	} else {
		// Non-deterministic step — run agent with retry
		let lastError: string | undefined;
		const maxRetries = opts.config.maxRetries;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			result.retryCount = attempt;

			try {
				const agentResult = await runAgent(step, opts.task, state, opts.cwd, runDir, opts.projectConfig);
				result.status = "passed";
				result.output = agentResult.output;
				result.cost = agentResult.cost;

				// Save agent output
				await writeFile(
					join(runDir, `${step.id}.json`),
					JSON.stringify(agentResult, null, 2),
				);

				break;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);

				if (attempt < maxRetries) {
					await emitEvent({
						timestamp: new Date().toISOString(),
						runId: state.id,
						type: "step:retry",
						stepId: step.id,
						data: { attempt: attempt + 1, error: lastError },
					});
				}
			}
		}

		if (result.status === "running") {
			result.status = "failed";
			result.error = `Failed after ${maxRetries + 1} attempts: ${lastError}`;
		}
	}

	result.completedAt = new Date().toISOString();

	await emitEvent({
		timestamp: result.completedAt,
		runId: state.id,
		type: result.status === "passed" ? "step:pass" : "step:fail",
		stepId: step.id,
		data: { cost: result.cost?.cost },
	});

	return result;
}

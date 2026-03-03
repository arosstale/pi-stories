/** pi-stories error types */

export class PiStoriesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiStoriesError";
	}
}

export class ConfigError extends PiStoriesError {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export class PipelineError extends PiStoriesError {
	public stepId: string;
	public retryable: boolean;

	constructor(stepId: string, message: string, retryable = true) {
		super(`Step "${stepId}": ${message}`);
		this.name = "PipelineError";
		this.stepId = stepId;
		this.retryable = retryable;
	}
}

export class RuntimeError extends PiStoriesError {
	public runtime: string;

	constructor(runtime: string, message: string) {
		super(`Runtime "${runtime}": ${message}`);
		this.name = "RuntimeError";
		this.runtime = runtime;
	}
}

export class BudgetExceededError extends PiStoriesError {
	public spent: number;
	public budget: number;

	constructor(spent: number, budget: number) {
		super(`Budget exceeded: $${spent.toFixed(4)} spent of $${budget.toFixed(2)} budget`);
		this.name = "BudgetExceededError";
		this.spent = spent;
		this.budget = budget;
	}
}

export class GateError extends PiStoriesError {
	public gate: string;
	public exitCode: number;

	constructor(gate: string, exitCode: number, output: string) {
		super(`Gate "${gate}" failed (exit ${exitCode}): ${output.slice(0, 200)}`);
		this.name = "GateError";
		this.gate = gate;
		this.exitCode = exitCode;
	}
}

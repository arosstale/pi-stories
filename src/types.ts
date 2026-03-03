/** pi-stories core types */

// ─── Pipeline ───────────────────────────────────────────

export type StepKind = "D" | "N";

export interface PipelineStep {
	id: string;
	kind: StepKind;
	name: string;
	/** For [N] steps: which agent role to use */
	role?: AgentRole;
	/** For [N] steps: which cost tier */
	tier?: CostTier;
	/** For [D] steps: the command(s) to run */
	commands?: string[];
}

export interface PipelineConfig {
	steps: PipelineStep[];
	maxRetries: number;
	budget: number;
}

export type PipelineStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface StepResult {
	stepId: string;
	status: PipelineStatus;
	startedAt: string;
	completedAt?: string;
	output?: string;
	error?: string;
	cost?: CostEntry;
	retryCount: number;
}

export interface RunState {
	id: string;
	task: string;
	startedAt: string;
	completedAt?: string;
	status: PipelineStatus;
	steps: StepResult[];
	totalCost: number;
	totalTokens: number;
}

// ─── Agent Roles ────────────────────────────────────────

export type AgentRole = "scout" | "planner" | "builder" | "reviewer" | "architect";

// ─── Cost ───────────────────────────────────────────────

export type CostTier = 1 | 2 | 3;

export interface CostEntry {
	runtime: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	tier: CostTier;
}

export interface ModelPricing {
	id: string;
	inputPer1k: number;
	outputPer1k: number;
	tier: CostTier;
}

// ─── Runtime ────────────────────────────────────────────

export interface AgentRuntime {
	name: string;
	available(): Promise<boolean>;
	spawn(task: AgentTask): Promise<RunHandle>;
	status(handle: RunHandle): Promise<AgentStatus>;
	kill(handle: RunHandle): Promise<void>;
	output(handle: RunHandle): Promise<string>;
	cost(handle: RunHandle): Promise<CostEntry | undefined>;
}

export interface AgentTask {
	role: AgentRole;
	prompt: string;
	model?: string;
	cwd?: string;
	contextFiles?: string[];
	timeout?: number;
}

export interface RunHandle {
	pid: number;
	runtime: string;
	startedAt: string;
}

export type AgentStatus = "running" | "completed" | "failed" | "timeout";

// ─── Config ─────────────────────────────────────────────

export interface ProjectConfig {
	/** Default runtime for each role */
	runtimes: Record<AgentRole, string>;
	/** Model for each cost tier */
	models: Record<CostTier, string>;
	/** Budget ceiling in dollars */
	budget: number;
	/** Max retries per [N] step */
	maxRetries: number;
	/** [D] gate commands */
	gates: {
		lint?: string;
		format?: string;
		typecheck?: string;
		test?: string;
	};
	/** Git settings */
	git: {
		baseBranch: string;
		autoPr: boolean;
	};
}

// ─── Events ─────────────────────────────────────────────

export type EventType =
	| "run:start"
	| "run:complete"
	| "run:fail"
	| "step:start"
	| "step:pass"
	| "step:fail"
	| "step:retry"
	| "agent:spawn"
	| "agent:complete"
	| "agent:fail"
	| "gate:pass"
	| "gate:fail"
	| "cost:update";

export interface PipelineEvent {
	timestamp: string;
	runId: string;
	type: EventType;
	stepId?: string;
	data?: Record<string, unknown>;
}

// ─── Doctor ─────────────────────────────────────────────

export type HealthStatus = "ok" | "warn" | "fail";

export interface HealthCheck {
	name: string;
	category: string;
	status: HealthStatus;
	message: string;
	fix?: string;
}

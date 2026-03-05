import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGates, runGate } from "../src/pipeline/gates.ts";
import { buildDefaultPipeline, buildQuickPipeline } from "../src/pipeline/steps.ts";
import { classifyThread } from "../src/threads/types.ts";
import type { PipelineStep, ProjectConfig } from "../src/types.ts";

// ── Pipeline Steps ────────────────────────────────────

describe("buildDefaultPipeline", () => {
	test("produces [D] and [N] steps in correct interleaving", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: {},
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);

		// First step is always [D] context
		expect(steps[0].kind).toBe("D");
		expect(steps[0].id).toBe("context");

		// [N] steps should follow [D] validation steps
		const nSteps = steps.filter((s) => s.kind === "N");
		expect(nSteps.length).toBeGreaterThanOrEqual(3); // scout, plan, build, review

		// Should end with [D] commit
		expect(steps[steps.length - 1].kind).toBe("D");
		expect(steps[steps.length - 1].id).toBe("commit");
	});

	test("includes quality gates when lint/format/typecheck configured", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: { lint: "biome check .", typecheck: "tsc --noEmit" },
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);
		const gateStep = steps.find((s) => s.id === "quality-gates");

		expect(gateStep).toBeDefined();
		expect(gateStep?.commands).toContain("biome check .");
		expect(gateStep?.commands).toContain("tsc --noEmit");
	});

	test("skips quality gates when no gates configured", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: {},
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);
		const gateStep = steps.find((s) => s.id === "quality-gates");
		expect(gateStep).toBeUndefined();
	});

	test("includes test step when test gate configured", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: { test: "bun test" },
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);
		const testStep = steps.find((s) => s.id === "test");
		expect(testStep).toBeDefined();
		expect(testStep?.commands).toContain("bun test");
	});

	test("assigns correct tiers to [N] steps", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: {},
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);
		const scout = steps.find((s) => s.id === "scout");
		const plan = steps.find((s) => s.id === "plan");
		const build = steps.find((s) => s.id === "build");
		const review = steps.find((s) => s.id === "review");

		expect(scout?.tier).toBe(1); // Cheap — exploration
		expect(plan?.tier).toBe(2); // Mid — reasoning
		expect(build?.tier).toBe(2); // Mid — implementation
		expect(review?.tier).toBe(3); // Expensive — judgment
	});

	test("assigns correct roles to [N] steps", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: {},
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);
		expect(steps.find((s) => s.id === "scout")?.role).toBe("scout");
		expect(steps.find((s) => s.id === "plan")?.role).toBe("planner");
		expect(steps.find((s) => s.id === "build")?.role).toBe("builder");
		expect(steps.find((s) => s.id === "review")?.role).toBe("reviewer");
	});

	test("every step has a unique id", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: { lint: "eslint .", test: "jest" },
			budget: { daily: 5 },
		};

		const steps = buildDefaultPipeline(config);
		const ids = steps.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

// ── Quick Pipeline ────────────────────────────────────

describe("buildQuickPipeline", () => {
	test("produces minimal steps: context, build, gates, commit", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: { lint: "eslint .", test: "jest" },
			budget: { daily: 5 },
		};

		const steps = buildQuickPipeline(config);
		const ids = steps.map((s) => s.id);
		expect(ids).toContain("context");
		expect(ids).toContain("build");
		expect(ids).toContain("quality-gates");
		expect(ids).toContain("commit");
		// No scout, plan, or review
		expect(ids).not.toContain("scout");
		expect(ids).not.toContain("plan");
		expect(ids).not.toContain("review");
	});

	test("skips gates when none configured", () => {
		const config: ProjectConfig = {
			name: "test",
			runtimes: { default: "pi" },
			gates: {},
			budget: { daily: 5 },
		};

		const steps = buildQuickPipeline(config);
		expect(steps.find((s) => s.id === "quality-gates")).toBeUndefined();
	});
});

// ── Gates ─────────────────────────────────────────────

describe("runGate", () => {
	test("succeeds on passing command", async () => {
		const step: PipelineStep = {
			id: "test-gate",
			kind: "D",
			name: "Test gate",
			commands: ["echo hello"],
		};

		const output = await runGate(step, process.cwd());
		expect(output).toContain("hello");
	});

	test("fails on non-zero exit code", async () => {
		const step: PipelineStep = {
			id: "fail-gate",
			kind: "D",
			name: "Fail gate",
			commands: ["exit 1"],
		};

		try {
			await runGate(step, process.cwd());
			expect(true).toBe(false); // Should not reach
		} catch (err) {
			expect((err as Error).message).toContain("Fail gate");
		}
	});

	test("skips when no commands configured", async () => {
		const step: PipelineStep = {
			id: "skip-gate",
			kind: "D",
			name: "Skip gate",
			commands: [],
		};

		const output = await runGate(step, process.cwd());
		expect(output).toContain("skipped");
	});

	test("runs multiple commands in sequence", async () => {
		const step: PipelineStep = {
			id: "multi-gate",
			kind: "D",
			name: "Multi gate",
			commands: ["echo first", "echo second"],
		};

		const output = await runGate(step, process.cwd());
		expect(output).toContain("first");
		expect(output).toContain("second");
	});

	test("stops on first failing command", async () => {
		const step: PipelineStep = {
			id: "fail-early",
			kind: "D",
			name: "Fail early",
			commands: ["exit 1", "echo should-not-run"],
		};

		try {
			await runGate(step, process.cwd());
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).not.toContain("should-not-run");
		}
	});
});

// ── Validation Gates ──────────────────────────────────

describe("runGate (validation)", () => {
	test("validates a passed step with sufficient output", async () => {
		const step: PipelineStep = {
			id: "validate-scout",
			kind: "D",
			name: "Validate scout",
			validate: "scout",
		};
		const state = {
			id: "test",
			task: "test",
			startedAt: new Date().toISOString(),
			status: "running" as const,
			steps: [{ stepId: "scout", status: "passed" as const, startedAt: "", output: "Found 5 files in src/: main.ts, utils.ts, config.ts, types.ts, index.ts. Key patterns identified." }],
			totalCost: 0,
			totalTokens: 0,
		};

		const output = await runGate(step, process.cwd(), state);
		expect(output).toContain("Validated");
		expect(output).toContain("scout");
	});

	test("rejects step with empty output", async () => {
		const step: PipelineStep = {
			id: "validate-scout",
			kind: "D",
			name: "Validate scout",
			validate: "scout",
		};
		const state = {
			id: "test",
			task: "test",
			startedAt: new Date().toISOString(),
			status: "running" as const,
			steps: [{ stepId: "scout", status: "passed" as const, startedAt: "", output: "" }],
			totalCost: 0,
			totalTokens: 0,
		};

		try {
			await runGate(step, process.cwd(), state);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("empty output");
		}
	});

	test("rejects step with too-short output", async () => {
		const step: PipelineStep = {
			id: "validate-build",
			kind: "D",
			name: "Validate build",
			validate: "build",
		};
		const state = {
			id: "test",
			task: "test",
			startedAt: new Date().toISOString(),
			status: "running" as const,
			steps: [{ stepId: "build", status: "passed" as const, startedAt: "", output: "ok done" }],
			totalCost: 0,
			totalTokens: 0,
		};

		try {
			await runGate(step, process.cwd(), state);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("too short");
		}
	});

	test("rejects when target step not found", async () => {
		const step: PipelineStep = {
			id: "validate-ghost",
			kind: "D",
			name: "Validate ghost",
			validate: "nonexistent",
		};
		const state = {
			id: "test",
			task: "test",
			startedAt: new Date().toISOString(),
			status: "running" as const,
			steps: [],
			totalCost: 0,
			totalTokens: 0,
		};

		try {
			await runGate(step, process.cwd(), state);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("not found");
		}
	});

	test("rejects failed review step", async () => {
		const step: PipelineStep = {
			id: "validate-review",
			kind: "D",
			name: "Validate review",
			validate: "review",
		};
		const state = {
			id: "test",
			task: "test",
			startedAt: new Date().toISOString(),
			status: "running" as const,
			steps: [{ stepId: "review", status: "passed" as const, startedAt: "", output: "FAIL: Found 3 bugs in the implementation that need fixing before merge." }],
			totalCost: 0,
			totalTokens: 0,
		};

		try {
			await runGate(step, process.cwd(), state);
			expect(true).toBe(false);
		} catch (err) {
			expect((err as Error).message).toContain("FAIL");
		}
	});
});

// ── Gate Detection ────────────────────────────────────

describe("detectGates", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "pi-stories-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("detects bun project gates from package.json", async () => {
		await writeFile(
			join(tmpDir, "package.json"),
			JSON.stringify({
				scripts: { lint: "biome check .", test: "bun test", typecheck: "tsc --noEmit" },
			}),
		);
		await writeFile(join(tmpDir, "bun.lockb"), "");

		const gates = await detectGates(tmpDir);
		expect(gates.lint).toBe("bun run lint");
		expect(gates.test).toBe("bun test");
		expect(gates.typecheck).toBe("bun run typecheck");
	});

	test("detects npm project", async () => {
		await writeFile(
			join(tmpDir, "package.json"),
			JSON.stringify({ scripts: { lint: "eslint ." } }),
		);

		const gates = await detectGates(tmpDir);
		expect(gates.lint).toBe("npm run lint");
	});

	test("returns empty for project with no recognizable config", async () => {
		const gates = await detectGates(tmpDir);
		expect(Object.keys(gates).length).toBe(0);
	});
});

// ── Thread Classification ─────────────────────────────

describe("classifyThread", () => {
	test("sling → base thread", () => {
		expect(classifyThread("sling", {})).toBe("base");
	});

	test("sling --no-review → Z thread", () => {
		expect(classifyThread("sling", { noReview: true })).toBe("Z");
	});

	test("sling --long → L thread", () => {
		expect(classifyThread("sling", { long: true })).toBe("L");
	});

	test("sling with high maxDuration → L thread", () => {
		expect(classifyThread("sling", { maxDuration: 7200000 })).toBe("L");
	});

	test("parallel → P thread", () => {
		expect(classifyThread("parallel", {})).toBe("P");
	});

	test("parallel --fusion → F thread", () => {
		expect(classifyThread("parallel", { fusion: true })).toBe("F");
	});

	test("run → C thread", () => {
		expect(classifyThread("run", {})).toBe("C");
	});

	test("run with depth → B thread", () => {
		expect(classifyThread("run", { depth: 2 })).toBe("B");
	});

	test("unknown command → base thread", () => {
		expect(classifyThread("whatever", {})).toBe("base");
	});
});

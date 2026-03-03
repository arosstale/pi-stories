import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPipeline } from "../src/pipeline/engine.ts";
import type { PipelineConfig, PipelineStep, ProjectConfig } from "../src/types.ts";

describe("pipeline integration", () => {
	let tmpDir: string;
	let configDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "pi-stories-int-"));
		configDir = join(tmpDir, ".pi-stories");
		await mkdir(join(configDir, "runs"), { recursive: true });

		// Init git repo so [D] steps work
		const git = Bun.spawn(["git", "init"], { cwd: tmpDir, stdout: "pipe", stderr: "pipe" });
		await git.exited;
		const add = Bun.spawn(["git", "add", "."], { cwd: tmpDir, stdout: "pipe", stderr: "pipe" });
		await add.exited;
		const commit = Bun.spawn(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmpDir, stdout: "pipe", stderr: "pipe" });
		await commit.exited;
	});

	afterEach(async () => {
		await new Promise((r) => setTimeout(r, 50));
		try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* EBUSY */ }
	});

	test("dry run shows plan without executing", async () => {
		const steps: PipelineStep[] = [
			{ id: "ctx", kind: "D", name: "Context", commands: ["echo context"] },
			{ id: "build", kind: "N", name: "Build", role: "builder", tier: 2 },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		const result = await runPipeline({
			task: "test task",
			config,
			cwd: tmpDir,
			dryRun: true,
		});

		expect(result.status).toBe("skipped");
		expect(result.steps.length).toBe(0); // Dry run doesn't execute steps
	});

	test("[D] gate step passes on success", async () => {
		const steps: PipelineStep[] = [
			{ id: "gate", kind: "D", name: "Echo gate", commands: ["echo hello"] },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		const result = await runPipeline({ task: "test", config, cwd: tmpDir });

		expect(result.status).toBe("passed");
		expect(result.steps.length).toBe(1);
		expect(result.steps[0].status).toBe("passed");
		expect(result.steps[0].output).toContain("hello");
	});

	test("[D] gate step fails on non-zero exit", async () => {
		const steps: PipelineStep[] = [
			{ id: "fail-gate", kind: "D", name: "Fail", commands: ["exit 1"] },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		const result = await runPipeline({ task: "test", config, cwd: tmpDir });

		expect(result.status).toBe("failed");
		expect(result.steps[0].status).toBe("failed");
	});

	test("pipeline stops after first failed step", async () => {
		const steps: PipelineStep[] = [
			{ id: "pass", kind: "D", name: "Pass", commands: ["echo ok"] },
			{ id: "fail", kind: "D", name: "Fail", commands: ["exit 1"] },
			{ id: "never", kind: "D", name: "Never", commands: ["echo never"] },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		const result = await runPipeline({ task: "test", config, cwd: tmpDir });

		expect(result.status).toBe("failed");
		expect(result.steps.length).toBe(2); // "never" step was never reached
	});

	test("multiple [D] steps execute in sequence", async () => {
		const steps: PipelineStep[] = [
			{ id: "a", kind: "D", name: "Step A", commands: ["echo A"] },
			{ id: "b", kind: "D", name: "Step B", commands: ["echo B"] },
			{ id: "c", kind: "D", name: "Step C", commands: ["echo C"] },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		const result = await runPipeline({ task: "test", config, cwd: tmpDir });

		expect(result.status).toBe("passed");
		expect(result.steps.length).toBe(3);
		expect(result.steps[0].output).toContain("A");
		expect(result.steps[1].output).toContain("B");
		expect(result.steps[2].output).toContain("C");
	});

	test("onStep callback fires for each step", async () => {
		const fired: string[] = [];
		const steps: PipelineStep[] = [
			{ id: "x", kind: "D", name: "X", commands: ["echo x"] },
			{ id: "y", kind: "D", name: "Y", commands: ["echo y"] },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		await runPipeline({
			task: "test",
			config,
			cwd: tmpDir,
			onStep: (step, _result) => fired.push(step.id),
		});

		expect(fired).toEqual(["x", "y"]);
	});

	test("run state persists to disk", async () => {
		const steps: PipelineStep[] = [
			{ id: "echo", kind: "D", name: "Echo", commands: ["echo persisted"] },
		];

		const config: PipelineConfig = { steps, maxRetries: 0, budget: 1 };
		const result = await runPipeline({ task: "test", config, cwd: tmpDir });

		// Check that status.json was written
		const statusPath = join(configDir, "runs", result.id, "status.json");
		const statusFile = Bun.file(statusPath);
		expect(await statusFile.exists()).toBe(true);

		const persisted = JSON.parse(await statusFile.text());
		expect(persisted.status).toBe("passed");
		expect(persisted.id).toBe(result.id);
	});
});

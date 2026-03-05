/** [D] Deterministic gates — lint, test, typecheck, format, validation */

import { GateError } from "../errors.ts";
import type { PipelineStep, RunState } from "../types.ts";

const IS_WIN = process.platform === "win32";

/** Run a deterministic gate step */
export async function runGate(step: PipelineStep, cwd: string, state?: RunState): Promise<string> {
	// Validation gates check previous step output instead of running commands
	if (step.validate) {
		return runValidation(step, state);
	}

	if (!step.commands || step.commands.length === 0) {
		return `[${step.name}] No commands configured — skipped`;
	}

	const outputs: string[] = [];

	for (const cmd of step.commands) {
		const result = await runCommand(cmd, cwd);
		outputs.push(result.output);

		if (result.exitCode !== 0) {
			throw new GateError(step.name, result.exitCode, result.output);
		}
	}

	return outputs.join("\n");
}

/** Validate output from a previous step — check it's non-empty and meets criteria */
function runValidation(step: PipelineStep, state?: RunState): string {
	const targetId = step.validate!;
	if (!state) {
		throw new GateError(step.name, 1, "No pipeline state available for validation");
	}

	const targetStep = state.steps.find((s) => s.stepId === targetId);
	if (!targetStep) {
		throw new GateError(step.name, 1, `Target step "${targetId}" not found in pipeline state`);
	}

	if (targetStep.status !== "passed") {
		throw new GateError(step.name, 1, `Target step "${targetId}" did not pass (status: ${targetStep.status})`);
	}

	const output = targetStep.output ?? "";

	// Check non-empty output
	if (output.trim().length === 0) {
		throw new GateError(step.name, 1, `Step "${targetId}" produced empty output`);
	}

	// Check minimum length (agents that just echo back the prompt are useless)
	if (output.trim().length < 50) {
		throw new GateError(step.name, 1, `Step "${targetId}" output too short (${output.trim().length} chars) — likely not a real response`);
	}

	// Check for error patterns in output
	const errorPatterns = [
		/^error:/im,
		/^fatal:/im,
		/unhandled.*exception/i,
		/stack.*trace/i,
	];
	for (const pattern of errorPatterns) {
		if (pattern.test(output)) {
			throw new GateError(step.name, 1, `Step "${targetId}" output contains error pattern: ${pattern.source}`);
		}
	}

	// For review steps, check for explicit PASS/FAIL
	if (targetId.includes("review")) {
		if (/\bFAIL\b/i.test(output) && !/\bPASS\b/i.test(output)) {
			throw new GateError(step.name, 1, `Review step "${targetId}" returned FAIL`);
		}
	}

	return `[${step.name}] Validated "${targetId}" — ${output.trim().length} chars, no errors`;
}

/** Run a shell command and capture output */
async function runCommand(cmd: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	// Use bash on Unix, cmd /c on Windows (Git Bash handles bash fine)
	const shellCmd = IS_WIN ? ["bash", "-c", cmd] : ["bash", "-c", cmd];

	const proc = Bun.spawn(shellCmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	return {
		exitCode,
		output: stdout + (stderr ? `\n[stderr] ${stderr}` : ""),
	};
}

/** Auto-detect available gates from project files */
export async function detectGates(cwd: string): Promise<Record<string, string | undefined>> {
	const gates: Record<string, string | undefined> = {};

	// Detect package manager and scripts
	const pkgPath = `${cwd}/package.json`;
	try {
		const pkg = JSON.parse(await Bun.file(pkgPath).text());
		const scripts = pkg.scripts ?? {};
		const pm = (await Bun.file(`${cwd}/bun.lockb`).exists())
			? "bun"
			: (await Bun.file(`${cwd}/pnpm-lock.yaml`).exists())
				? "pnpm"
				: "npm";

		if (scripts.lint) gates.lint = `${pm} run lint`;
		if (scripts.format) gates.format = `${pm} run format`;
		if (scripts.typecheck) gates.typecheck = `${pm} run typecheck`;
		if (scripts.check) gates.typecheck = `${pm} run check`;
		if (scripts.test) gates.test = `${pm} test`;
	} catch {
		// No package.json
	}

	// Python
	try {
		if (await Bun.file(`${cwd}/pyproject.toml`).exists()) {
			gates.lint = "ruff check .";
			gates.format = "ruff format --check .";
			gates.test = "pytest";
		}
	} catch { /* */ }

	// Go
	try {
		if (await Bun.file(`${cwd}/go.mod`).exists()) {
			gates.lint = "golangci-lint run";
			gates.test = "go test ./...";
		}
	} catch { /* */ }

	// Rust
	try {
		if (await Bun.file(`${cwd}/Cargo.toml`).exists()) {
			gates.lint = "cargo clippy -- -D warnings";
			gates.format = "cargo fmt --check";
			gates.test = "cargo test";
		}
	} catch { /* */ }

	return gates;
}

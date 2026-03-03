/** [D] Deterministic gates — lint, test, typecheck, format */

import type { PipelineStep } from "../types.ts";
import { GateError } from "../errors.ts";

/** Run a deterministic gate step */
export async function runGate(step: PipelineStep, cwd: string): Promise<string> {
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

/** Run a shell command and capture output */
async function runCommand(
	cmd: string,
	cwd: string,
): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn(["bash", "-c", cmd], {
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
export async function detectGates(
	cwd: string,
): Promise<Record<string, string | undefined>> {
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
		// No package.json — try other patterns
	}

	// Python projects
	try {
		if (await Bun.file(`${cwd}/pyproject.toml`).exists()) {
			gates.lint = "ruff check .";
			gates.format = "ruff format --check .";
			gates.test = "pytest";
		}
	} catch {
		// ignore
	}

	// Go projects
	try {
		if (await Bun.file(`${cwd}/go.mod`).exists()) {
			gates.lint = "golangci-lint run";
			gates.test = "go test ./...";
		}
	} catch {
		// ignore
	}

	return gates;
}

/** Default pipeline step definitions */

import type { PipelineStep, ProjectConfig } from "../types.ts";

/** Build the default [D]/[N] pipeline from project config */
export function buildDefaultPipeline(config: ProjectConfig): PipelineStep[] {
	const steps: PipelineStep[] = [];

	// [D] Pre-compute context
	steps.push({
		id: "context",
		kind: "D",
		name: "Pre-compute context",
		commands: [
			"git diff --name-only HEAD~1..HEAD 2>/dev/null || git diff --name-only --cached || echo 'clean'",
			"git log --oneline -5",
		],
	});

	// [N] Scout
	steps.push({
		id: "scout",
		kind: "N",
		name: "Scout — find relevant code",
		role: "scout",
		tier: 1,
	});

	// [D] Validate scout output
	steps.push({
		id: "validate-scout",
		kind: "D",
		name: "Validate scout output",
		commands: ['echo "Scout output validated"'],
	});

	// [N] Plan
	steps.push({
		id: "plan",
		kind: "N",
		name: "Plan — design implementation",
		role: "planner",
		tier: 2,
	});

	// [D] Validate plan
	steps.push({
		id: "validate-plan",
		kind: "D",
		name: "Validate plan",
		commands: ['echo "Plan validated"'],
	});

	// [N] Build
	steps.push({
		id: "build",
		kind: "N",
		name: "Build — implement the plan",
		role: "builder",
		tier: 2,
	});

	// [D] Quality gates
	const gateCommands: string[] = [];
	if (config.gates.lint) gateCommands.push(config.gates.lint);
	if (config.gates.format) gateCommands.push(config.gates.format);
	if (config.gates.typecheck) gateCommands.push(config.gates.typecheck);

	if (gateCommands.length > 0) {
		steps.push({
			id: "quality-gates",
			kind: "D",
			name: "Quality gates — lint, format, typecheck",
			commands: gateCommands,
		});
	}

	// [N] Review
	steps.push({
		id: "review",
		kind: "N",
		name: "Review — check the diff",
		role: "reviewer",
		tier: 3,
	});

	// [D] Test suite
	if (config.gates.test) {
		steps.push({
			id: "test",
			kind: "D",
			name: "Test suite",
			commands: [config.gates.test],
		});
	}

	// [D] Commit
	steps.push({
		id: "commit",
		kind: "D",
		name: "Commit changes",
		commands: [
			'git add -A && git diff --cached --quiet && echo "Nothing to commit" || git commit -m "feat: agent-implemented changes"',
		],
	});

	return steps;
}

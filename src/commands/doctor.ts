/** pi-stories doctor — 11-category health check */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, isInitialized, getConfigDir } from "../config.ts";
import { discoverRuntimes } from "../runtimes/registry.ts";
import type { HealthCheck, HealthStatus } from "../types.ts";

interface CheckResult {
	name: string;
	category: string;
	status: HealthStatus;
	message: string;
	fix?: string;
}

export async function runDoctor(opts?: { category?: string; verbose?: boolean; fix?: boolean }): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const root = findProjectRoot();
	const configDir = getConfigDir(root);

	const categories: Record<string, () => Promise<CheckResult[]>> = {
		dependencies: () => checkDependencies(),
		config: () => checkConfig(root, configDir),
		structure: () => checkStructure(configDir),
		databases: () => checkDatabases(configDir),
		git: () => checkGit(root),
		runtimes: () => checkRuntimes(),
		environment: () => checkEnvironment(),
		permissions: () => checkPermissions(root),
		disk: () => checkDisk(configDir),
		version: () => checkVersion(),
		ecosystem: () => checkEcosystem(),
	};

	const categoriesToRun = opts?.category ? { [opts.category]: categories[opts.category] } : categories;

	for (const [catName, checkFn] of Object.entries(categoriesToRun)) {
		if (!checkFn) continue;
		try {
			const checks = await checkFn();
			results.push(...checks);
		} catch (err) {
			results.push({
				name: catName,
				category: catName,
				status: "fail",
				message: `Check crashed: ${err}`,
			});
		}
	}

	return results;
}

async function checkDependencies(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// git
	const git = await cmdCheck("git", ["--version"]);
	results.push({ name: "git", category: "dependencies", ...git });

	// bun
	results.push({
		name: "bun",
		category: "dependencies",
		status: "ok",
		message: `v${Bun.version}`,
	});

	// jq (optional but useful)
	const jq = await cmdCheck("jq", ["--version"]);
	results.push({
		name: "jq",
		category: "dependencies",
		status: jq.status === "ok" ? "ok" : "warn",
		message: jq.message,
		fix: jq.status !== "ok" ? "Install jq for JSON querying: https://jqlang.github.io/jq/" : undefined,
	});

	return results;
}

async function checkConfig(root: string, configDir: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	results.push({
		name: "initialized",
		category: "config",
		status: isInitialized(root) ? "ok" : "fail",
		message: isInitialized(root) ? ".pi-stories/ found" : "Not initialized",
		fix: "Run: pi-stories init",
	});

	if (isInitialized(root)) {
		const configPath = join(configDir, "config.yaml");
		results.push({
			name: "config.yaml",
			category: "config",
			status: existsSync(configPath) ? "ok" : "warn",
			message: existsSync(configPath) ? "Present" : "Missing (using defaults)",
		});
	}

	return results;
}

async function checkStructure(configDir: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const dirs = ["runs"];

	for (const dir of dirs) {
		const path = join(configDir, dir);
		results.push({
			name: `dir:${dir}`,
			category: "structure",
			status: existsSync(path) ? "ok" : "warn",
			message: existsSync(path) ? "Present" : "Missing",
			fix: `mkdir -p ${path}`,
		});
	}

	return results;
}

async function checkDatabases(configDir: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const dbs = ["mail.db", "sessions.db", "merge-queue.db", "costs.db"];

	for (const dbFile of dbs) {
		const path = join(configDir, dbFile);
		const exists = existsSync(path);
		results.push({
			name: dbFile,
			category: "databases",
			status: exists ? "ok" : "warn",
			message: exists ? "Present" : "Will be created on first use",
		});
	}

	return results;
}

async function checkGit(root: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// Check if in git repo
	const isGit = existsSync(join(root, ".git"));
	results.push({
		name: "git-repo",
		category: "git",
		status: isGit ? "ok" : "fail",
		message: isGit ? "Git repository found" : "Not a git repository",
		fix: "Run: git init",
	});

	if (isGit) {
		// Check for uncommitted changes
		const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe" });
		await proc.exited;
		const output = (await new Response(proc.stdout).text()).trim();
		const clean = output === "";
		results.push({
			name: "git-clean",
			category: "git",
			status: clean ? "ok" : "warn",
			message: clean ? "Working tree clean" : `${output.split("\n").length} uncommitted changes`,
		});

		// Check branch
		const branchProc = Bun.spawn(["git", "branch", "--show-current"], { cwd: root, stdout: "pipe" });
		await branchProc.exited;
		const branch = (await new Response(branchProc.stdout).text()).trim();
		results.push({
			name: "git-branch",
			category: "git",
			status: "ok",
			message: `Current branch: ${branch}`,
		});
	}

	return results;
}

async function checkRuntimes(): Promise<CheckResult[]> {
	const runtimes = await discoverRuntimes();
	return runtimes.map((r) => ({
		name: `runtime:${r.name}`,
		category: "runtimes",
		status: r.available ? "ok" : ("warn" as HealthStatus),
		message: r.available ? (r.path ?? "Available") : "Not found",
	}));
}

async function checkEnvironment(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	const envVars = [
		{ name: "ANTHROPIC_API_KEY", required: false },
		{ name: "OPENAI_API_KEY", required: false },
		{ name: "GOOGLE_API_KEY", required: false },
		{ name: "OPENROUTER_API_KEY", required: false },
	];

	for (const { name, required } of envVars) {
		const set = !!process.env[name];
		results.push({
			name: `env:${name}`,
			category: "environment",
			status: set ? "ok" : required ? "fail" : "warn",
			message: set ? "Set" : "Not set",
		});
	}

	return results;
}

async function checkPermissions(root: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	try {
		const testFile = join(root, ".pi-stories", ".write-test");
		await Bun.write(testFile, "test");
		const { unlinkSync } = require("node:fs");
		unlinkSync(testFile);
		results.push({ name: "write-access", category: "permissions", status: "ok", message: "Write access confirmed" });
	} catch {
		results.push({ name: "write-access", category: "permissions", status: "fail", message: "Cannot write to .pi-stories/" });
	}

	return results;
}

async function checkDisk(configDir: string): Promise<CheckResult[]> {
	// Basic check — count run directories
	const results: CheckResult[] = [];

	try {
		const runsDir = join(configDir, "runs");
		if (existsSync(runsDir)) {
			const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: runsDir, onlyFiles: false }));
			results.push({
				name: "run-count",
				category: "disk",
				status: entries.length > 100 ? "warn" : "ok",
				message: `${entries.length} runs stored`,
				fix: entries.length > 100 ? "Run: pi-stories clean --runs --days 30" : undefined,
			});
		}
	} catch {
		// ignore
	}

	return results;
}

async function checkVersion(): Promise<CheckResult[]> {
	return [
		{
			name: "pi-stories",
			category: "version",
			status: "ok",
			message: "v0.4.0",
		},
	];
}

async function checkEcosystem(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// Check for mulch
	const mulch = await cmdCheck("mulch", ["--version"]);
	results.push({
		name: "mulch",
		category: "ecosystem",
		status: mulch.status === "ok" ? "ok" : "warn",
		message: mulch.message,
	});

	return results;
}

/** Helper to check a CLI command */
async function cmdCheck(cmd: string, args: string[]): Promise<{ status: HealthStatus; message: string }> {
	try {
		const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		const output = (await new Response(proc.stdout).text()).trim();
		return { status: code === 0 ? "ok" : "warn", message: output || `Exit code ${code}` };
	} catch {
		return { status: "warn", message: "Not found" };
	}
}

/** Print doctor results to console */
export function printDoctorResults(results: CheckResult[], verbose?: boolean): void {
	const categories = [...new Set(results.map((r) => r.category))];

	for (const cat of categories) {
		console.log(chalk.bold(`\n  ${cat}`));
		const checks = results.filter((r) => r.category === cat);

		for (const check of checks) {
			if (!verbose && check.status === "ok") {
				// In non-verbose mode, only show the count
				continue;
			}

			const icon =
				check.status === "ok" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
			console.log(`    ${icon} ${check.name.padEnd(24)} ${chalk.dim(check.message)}`);
			if (check.fix && check.status !== "ok") {
				console.log(chalk.dim(`      Fix: ${check.fix}`));
			}
		}

		const okCount = checks.filter((c) => c.status === "ok").length;
		if (!verbose && okCount > 0) {
			console.log(chalk.green(`    ✓ ${okCount} checks passed`));
		}
	}

	const failures = results.filter((r) => r.status === "fail");
	const warnings = results.filter((r) => r.status === "warn");
	console.log("");
	if (failures.length === 0 && warnings.length === 0) {
		console.log(chalk.green("  All checks passed! ✨"));
	} else if (failures.length === 0) {
		console.log(chalk.yellow(`  ${warnings.length} warning(s), 0 failures`));
	} else {
		console.log(chalk.red(`  ${failures.length} failure(s), ${warnings.length} warning(s)`));
	}
}

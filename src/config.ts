/** pi-stories configuration loader */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";
import type { ProjectConfig } from "./types.ts";

const CONFIG_DIR = ".pi-stories";
const CONFIG_FILE = "config.yaml";

export const DEFAULT_CONFIG: ProjectConfig = {
	runtimes: {
		scout: "pi",
		planner: "pi",
		builder: "pi",
		reviewer: "pi",
		architect: "pi",
	},
	models: {
		1: "claude-haiku-4-5",
		2: "claude-sonnet-4-5",
		3: "claude-opus-4-5",
	},
	budget: 5.0,
	maxRetries: 3,
	gates: {
		lint: undefined,
		format: undefined,
		typecheck: undefined,
		test: undefined,
	},
	git: {
		baseBranch: "main",
		autoPr: true,
	},
};

/** Find project root by walking up looking for .pi-stories/ or .git/ */
export function findProjectRoot(from: string = process.cwd()): string {
	let dir = from;
	while (true) {
		if (existsSync(join(dir, CONFIG_DIR))) return dir;
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return from;
}

/** Get the .pi-stories directory path */
export function getConfigDir(root?: string): string {
	return join(root ?? findProjectRoot(), CONFIG_DIR);
}

/** Check if pi-stories is initialized in this project */
export function isInitialized(root?: string): boolean {
	return existsSync(getConfigDir(root));
}

/** Load project config. Falls back to defaults for missing fields. */
export async function loadConfig(root?: string): Promise<ProjectConfig> {
	const configDir = getConfigDir(root);
	const configPath = join(configDir, CONFIG_FILE);

	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = parseYaml(raw);
		return mergeConfig(DEFAULT_CONFIG, parsed);
	} catch (err) {
		throw new ConfigError(`Failed to load config: ${err}`);
	}
}

/** Initialize .pi-stories/ in a project */
export async function initProject(root: string): Promise<string> {
	const configDir = join(root, CONFIG_DIR);

	await mkdir(configDir, { recursive: true });
	await mkdir(join(configDir, "runs"), { recursive: true });

	const configPath = join(configDir, CONFIG_FILE);
	if (!existsSync(configPath)) {
		await writeFile(configPath, generateYaml(DEFAULT_CONFIG));
	}

	// Add to .gitignore
	const gitignorePath = join(configDir, ".gitignore");
	await writeFile(
		gitignorePath,
		["# pi-stories runtime state", "runs/", "costs.db", "costs.db-wal", "costs.db-shm", ""].join(
			"\n",
		),
	);

	return configDir;
}

// ─── Simple YAML helpers (no dependency) ────────────────

function parseYaml(raw: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = raw.split("\n");
	let currentKey = "";

	for (const line of lines) {
		if (line.startsWith("#") || line.trim() === "") continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();

		if (indent === 0 && trimmed.includes(":")) {
			const [key, ...valueParts] = trimmed.split(":");
			const value = valueParts.join(":").trim();
			currentKey = key?.trim() ?? "";
			if (value) {
				result[currentKey] = parseValue(value);
			} else {
				result[currentKey] = {};
			}
		} else if (indent > 0 && currentKey && trimmed.includes(":")) {
			const [key, ...valueParts] = trimmed.split(":");
			const value = valueParts.join(":").trim();
			const parent = result[currentKey];
			if (parent && typeof parent === "object" && !Array.isArray(parent)) {
				(parent as Record<string, unknown>)[key?.trim() ?? ""] = parseValue(value);
			}
		}
	}

	return result;
}

function parseValue(v: string): string | number | boolean {
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
	return v.replace(/^["']|["']$/g, "");
}

function generateYaml(config: ProjectConfig): string {
	const lines: string[] = [
		"# pi-stories configuration",
		"# Blueprint Engine [D]/[N] + cost routing",
		"",
		"# Default runtime per agent role",
		"runtimes:",
		`  scout: ${config.runtimes.scout}`,
		`  planner: ${config.runtimes.planner}`,
		`  builder: ${config.runtimes.builder}`,
		`  reviewer: ${config.runtimes.reviewer}`,
		`  architect: ${config.runtimes.architect}`,
		"",
		"# Model per cost tier",
		"models:",
		`  1: ${config.models[1]}`,
		`  2: ${config.models[2]}`,
		`  3: ${config.models[3]}`,
		"",
		`budget: ${config.budget}`,
		`maxRetries: ${config.maxRetries}`,
		"",
		"# [D] gate commands (auto-detected if empty)",
		"gates:",
		`  lint: ${config.gates.lint ?? ""}`,
		`  format: ${config.gates.format ?? ""}`,
		`  typecheck: ${config.gates.typecheck ?? ""}`,
		`  test: ${config.gates.test ?? ""}`,
		"",
		"git:",
		`  baseBranch: ${config.git.baseBranch}`,
		`  autoPr: ${config.git.autoPr}`,
		"",
	];
	return lines.join("\n");
}

function mergeConfig(defaults: ProjectConfig, overrides: Record<string, unknown>): ProjectConfig {
	return {
		...defaults,
		...(overrides.budget !== undefined && { budget: Number(overrides.budget) }),
		...(overrides.maxRetries !== undefined && { maxRetries: Number(overrides.maxRetries) }),
		runtimes: {
			...defaults.runtimes,
			...((overrides.runtimes as Record<string, string>) ?? {}),
		},
		models: {
			...defaults.models,
			...((overrides.models as Record<number, string>) ?? {}),
		},
		gates: {
			...defaults.gates,
			...((overrides.gates as Record<string, string>) ?? {}),
		},
		git: {
			...defaults.git,
			...((overrides.git as Record<string, unknown>) ?? {}),
		},
	};
}

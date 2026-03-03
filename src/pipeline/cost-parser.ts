/** Cost parsing from runtime CLI output
 *
 * Extracts cost, token counts, and model name from stdout/stderr.
 * Supports: pi, claude, codex, and generic "$X.XX" patterns.
 */

import type { CostEntry, CostTier } from "../types.ts";

/** Known cost-per-1k-token rates */
const MODEL_PRICING: Record<string, { input: number; output: number; tier: CostTier }> = {
	"claude-haiku-4-5":   { input: 0.001, output: 0.005, tier: 1 },
	"claude-sonnet-4-5":  { input: 0.003, output: 0.015, tier: 2 },
	"claude-sonnet-4":    { input: 0.003, output: 0.015, tier: 2 },
	"claude-opus-4":      { input: 0.015, output: 0.075, tier: 3 },
	"gpt-4o-mini":        { input: 0.00015, output: 0.0006, tier: 1 },
	"gpt-4o":             { input: 0.005, output: 0.015, tier: 2 },
	"gpt-4.1":            { input: 0.002, output: 0.008, tier: 2 },
	"gemini-2.5-flash":   { input: 0.00015, output: 0.001, tier: 1 },
	"gemini-2.5-pro":     { input: 0.00125, output: 0.01, tier: 2 },
};

/** Parse cost info from runtime stdout + stderr */
export function parseCostFromOutput(
	runtime: string,
	stdout: string,
	stderr: string,
): CostEntry | undefined {
	const combined = `${stdout}\n${stderr}`;

	// Pattern 1: Direct cost — "Cost: $X.XXXX"
	const costMatch = combined.match(/[Cc]ost:\s*\$(\d+\.?\d*)/);

	// Pattern 2: Token counts — "1234 in / 567 out" or "input: 1234, output: 567"
	const tokenMatch =
		combined.match(/(\d+)\s*(?:in|input)[^0-9]*(\d+)\s*(?:out|output)/i) ??
		combined.match(/input[:\s]+(\d+)[^0-9]+output[:\s]+(\d+)/i);

	// Pattern 3: Model name — require colon or equals, not just space
	const modelMatch =
		combined.match(/[Mm]odel:\s*(\S+)/) ??
		combined.match(/model=["']?([a-zA-Z0-9._-]+)/);

	if (!costMatch && !tokenMatch) return undefined;

	const model = modelMatch?.[1] ?? "unknown";
	const inputTokens = tokenMatch ? Number.parseInt(tokenMatch[1], 10) : 0;
	const outputTokens = tokenMatch ? Number.parseInt(tokenMatch[2], 10) : 0;

	let cost = 0;
	let tier: CostTier = 2;

	if (costMatch) {
		cost = Number.parseFloat(costMatch[1]);
	} else if (tokenMatch) {
		const pricing = findPricing(model);
		if (pricing) {
			cost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
			tier = pricing.tier;
		}
	}

	const pricing = findPricing(model);
	if (pricing) tier = pricing.tier;

	return { runtime, model, inputTokens, outputTokens, cost, tier };
}

/** Find pricing for a model (exact match, then partial) */
export function findPricing(model: string): (typeof MODEL_PRICING)[string] | undefined {
	if (MODEL_PRICING[model]) return MODEL_PRICING[model];

	for (const [key, value] of Object.entries(MODEL_PRICING)) {
		if (model.includes(key) || key.includes(model)) return value;
	}

	return undefined;
}

/** Parse model name from runtime output */
export function parseModel(runtime: string, stderr: string): string | undefined {
	// Require "Model:" with colon, or "model=" with equals — not just "model " in prose
	const match =
		stderr.match(/[Mm]odel:\s*(\S+)/) ??
		stderr.match(/model=["']?([a-zA-Z0-9._-]+)/);
	return match?.[1];
}

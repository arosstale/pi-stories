import { describe, test, expect } from "bun:test";
import { parseCostFromOutput, findPricing, parseModel } from "../src/pipeline/cost-parser.ts";

describe("parseCostFromOutput", () => {
	test("parses pi-style cost output", () => {
		const stderr = "Cost: $0.0042 | Tokens: 1234 in / 567 out | Model: claude-sonnet-4";
		const result = parseCostFromOutput("pi", "", stderr);

		expect(result).toBeDefined();
		expect(result!.cost).toBe(0.0042);
		expect(result!.inputTokens).toBe(1234);
		expect(result!.outputTokens).toBe(567);
		expect(result!.model).toBe("claude-sonnet-4");
		expect(result!.tier).toBe(2);
	});

	test("parses cost from stdout when stderr is empty", () => {
		const stdout = "Result here\nCost: $0.15\nDone.";
		const result = parseCostFromOutput("claude", stdout, "");

		expect(result).toBeDefined();
		expect(result!.cost).toBe(0.15);
	});

	test("parses token counts without dollar amount", () => {
		const stderr = "Model: claude-haiku-4-5 | input: 500, output: 200";
		const result = parseCostFromOutput("pi", "", stderr);

		expect(result).toBeDefined();
		expect(result!.inputTokens).toBe(500);
		expect(result!.outputTokens).toBe(200);
		// Should calculate cost from pricing table
		expect(result!.cost).toBeGreaterThan(0);
		expect(result!.tier).toBe(1); // haiku = tier 1
	});

	test("returns undefined when no cost info found", () => {
		const result = parseCostFromOutput("pi", "Hello world", "");
		expect(result).toBeUndefined();
	});

	test("handles zero cost", () => {
		const stderr = "Cost: $0 | Tokens: 0 in / 0 out";
		const result = parseCostFromOutput("pi", "", stderr);

		expect(result).toBeDefined();
		expect(result!.cost).toBe(0);
	});

	test("handles large costs", () => {
		const stderr = "Cost: $12.50";
		const result = parseCostFromOutput("claude", "", stderr);

		expect(result).toBeDefined();
		expect(result!.cost).toBe(12.5);
	});
});

describe("findPricing", () => {
	test("exact match", () => {
		const p = findPricing("claude-sonnet-4");
		expect(p).toBeDefined();
		expect(p!.tier).toBe(2);
	});

	test("partial match with date suffix", () => {
		const p = findPricing("claude-haiku-4-5-20250101");
		expect(p).toBeDefined();
		expect(p!.tier).toBe(1);
	});

	test("returns undefined for unknown model", () => {
		expect(findPricing("totally-unknown-model")).toBeUndefined();
	});
});

describe("parseModel", () => {
	test("parses Model: prefix", () => {
		expect(parseModel("pi", "Model: claude-sonnet-4")).toBe("claude-sonnet-4");
	});

	test("parses model= prefix", () => {
		expect(parseModel("pi", 'model="gpt-4o"')).toBe("gpt-4o");
	});

	test("returns undefined when no model found", () => {
		expect(parseModel("pi", "no model here")).toBeUndefined();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkMail,
	closeMailDb,
	listMail,
	markRead,
	purgeMail,
	sendMail,
} from "../src/mail/store.ts";
import {
	closeSessionDb,
	createSession,
	getActiveSessions,
	getSession,
	updateSession,
} from "../src/sessions/store.ts";
import {
	calculateScorecard,
	closeThreadDb,
	getHistory,
	getThreadBreakdown,
	recordThread,
	saveScorecard,
} from "../src/threads/scorecard.ts";
import type { ThreadMetrics } from "../src/threads/types.ts";

// ── Mail Store ────────────────────────────────────────

describe("mail store", () => {
	let dir: string;

	beforeEach(async () => {
		closeMailDb();
		dir = await mkdtemp(join(tmpdir(), "pi-stories-mail-"));
	});

	afterEach(async () => {
		closeMailDb();
		// Give Windows a moment to release file handles
		await new Promise((r) => setTimeout(r, 50));
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			/* EBUSY on Windows */
		}
	});

	test("send and check mail", () => {
		sendMail(dir, {
			from: "builder-1",
			to: "orchestrator",
			subject: "Build done",
			body: "All tests pass",
			type: "worker_done",
			priority: "normal",
		});

		const inbox = checkMail(dir, "orchestrator");
		expect(inbox.length).toBe(1);
		expect(inbox[0].subject).toBe("Build done");
		expect(inbox[0].read).toBe(false);
	});

	test("priority ordering", () => {
		sendMail(dir, { from: "a", to: "x", subject: "low", body: "", type: "info", priority: "low" });
		sendMail(dir, {
			from: "b",
			to: "x",
			subject: "high",
			body: "",
			type: "error",
			priority: "high",
		});
		sendMail(dir, {
			from: "c",
			to: "x",
			subject: "normal",
			body: "",
			type: "info",
			priority: "normal",
		});

		const inbox = checkMail(dir, "x");
		expect(inbox[0].subject).toBe("high");
	});

	test("mark read", () => {
		sendMail(dir, {
			from: "a",
			to: "b",
			subject: "test",
			body: "",
			type: "info",
			priority: "normal",
		});
		const inbox = checkMail(dir, "b");
		expect(inbox.length).toBe(1);

		markRead(dir, inbox[0].id);

		// checkMail only returns unread — use listMail to verify
		const all = listMail(dir, { to: "b" });
		expect(all.length).toBe(1);
		expect(all[0].read).toBe(true);
	});

	test("list all mail", () => {
		sendMail(dir, { from: "a", to: "b", subject: "1", body: "", type: "info", priority: "normal" });
		sendMail(dir, { from: "c", to: "d", subject: "2", body: "", type: "info", priority: "normal" });

		const all = listMail(dir);
		expect(all.length).toBe(2);
	});

	test("purge all mail", () => {
		sendMail(dir, {
			from: "a",
			to: "b",
			subject: "old",
			body: "",
			type: "info",
			priority: "normal",
		});
		const purged = purgeMail(dir, { all: true });
		expect(purged).toBe(1);
		expect(listMail(dir).length).toBe(0);
	});
});

// ── Session Store ─────────────────────────────────────

describe("session store", () => {
	let dir: string;

	beforeEach(async () => {
		closeSessionDb();
		dir = await mkdtemp(join(tmpdir(), "pi-stories-sess-"));
	});

	afterEach(async () => {
		closeSessionDb();
		await new Promise((r) => setTimeout(r, 50));
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			/* EBUSY */
		}
	});

	test("create and retrieve session", () => {
		const session = createSession(dir, {
			name: "test-builder",
			runtime: "pi",
			role: "builder",
			task: "fix the bug",
		});

		expect(session.id).toBeDefined();
		expect(session.status).toBe("running");

		const fetched = getSession(dir, session.id);
		expect(fetched).toBeDefined();
		expect(fetched?.name).toBe("test-builder");
	});

	test("update session status", () => {
		const session = createSession(dir, {
			name: "test",
			runtime: "pi",
			role: "builder",
			task: "work",
		});

		updateSession(dir, session.id, { status: "completed", pid: 12345 });

		const updated = getSession(dir, session.id);
		expect(updated?.status).toBe("completed");
		expect(updated?.pid).toBe(12345);
	});

	test("list active sessions excludes completed", () => {
		createSession(dir, { name: "a", runtime: "pi", role: "builder", task: "t1" });
		createSession(dir, { name: "b", runtime: "pi", role: "scout", task: "t2" });
		const c = createSession(dir, { name: "c", runtime: "pi", role: "reviewer", task: "t3" });
		updateSession(dir, c.id, { status: "completed" });

		const active = getActiveSessions(dir);
		expect(active.length).toBe(2);
	});
});

// ── Thread Scorecard ──────────────────────────────────

describe("thread scorecard", () => {
	let dir: string;

	beforeEach(async () => {
		closeThreadDb();
		dir = await mkdtemp(join(tmpdir(), "pi-stories-thread-"));
	});

	afterEach(async () => {
		closeThreadDb();
		await new Promise((r) => setTimeout(r, 50));
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			/* EBUSY */
		}
	});

	test("empty scorecard", () => {
		const sc = calculateScorecard(dir);
		expect(sc.totalThreads).toBe(0);
		expect(sc.width).toBe(0);
		expect(sc.trustRatio).toBe(0);
	});

	test("records thread and reflects in scorecard", () => {
		const metrics: ThreadMetrics = {
			threadId: "test-1",
			type: "P",
			toolCalls: 15,
			duration: 30,
			checkpoints: 0,
			cost: 0.05,
			width: 3,
			depth: 0,
			reviewed: true,
		};

		recordThread(dir, metrics);
		const sc = calculateScorecard(dir);

		expect(sc.totalThreads).toBe(1);
		expect(sc.width).toBe(3);
		expect(sc.avgToolCalls).toBe(15);
	});

	test("trust ratio counts unreviewed threads", () => {
		recordThread(dir, {
			threadId: "t1",
			type: "Z",
			toolCalls: 5,
			duration: 10,
			checkpoints: 0,
			cost: 0.01,
			width: 1,
			depth: 0,
			reviewed: false,
		});
		recordThread(dir, {
			threadId: "t2",
			type: "base",
			toolCalls: 3,
			duration: 5,
			checkpoints: 0,
			cost: 0.01,
			width: 1,
			depth: 0,
			reviewed: true,
		});

		const sc = calculateScorecard(dir);
		expect(sc.trustRatio).toBe(0.5); // 1 of 2 unreviewed
	});

	test("save and retrieve history", () => {
		const sc = calculateScorecard(dir);
		saveScorecard(dir, sc);

		const history = getHistory(dir, 4);
		expect(history.length).toBe(1);
		expect(history[0].weekOf).toBe(sc.weekOf);
	});

	test("thread breakdown by type", () => {
		recordThread(dir, {
			threadId: "a",
			type: "P",
			toolCalls: 0,
			duration: 0,
			checkpoints: 0,
			cost: 0,
			width: 2,
			depth: 0,
			reviewed: true,
		});
		recordThread(dir, {
			threadId: "b",
			type: "P",
			toolCalls: 0,
			duration: 0,
			checkpoints: 0,
			cost: 0,
			width: 3,
			depth: 0,
			reviewed: true,
		});
		recordThread(dir, {
			threadId: "c",
			type: "C",
			toolCalls: 0,
			duration: 0,
			checkpoints: 0,
			cost: 0,
			width: 1,
			depth: 0,
			reviewed: true,
		});

		const breakdown = getThreadBreakdown(dir);
		expect(breakdown.P).toBe(2);
		expect(breakdown.C).toBe(1);
	});
});

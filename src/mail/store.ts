/** SQLite mail store — inter-agent messaging */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MailMessage, MailPriority, MailType } from "../types.ts";

let db: Database | null = null;

/** Close the DB handle — required for tests and clean shutdown */
export function closeMailDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

export function initMailDb(configDir: string): Database {
	if (db) return db;

	db = new Database(join(configDir, "mail.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			from_agent TEXT NOT NULL,
			to_agent TEXT NOT NULL,
			subject TEXT NOT NULL,
			body TEXT NOT NULL,
			type TEXT NOT NULL DEFAULT 'status',
			priority TEXT NOT NULL DEFAULT 'normal',
			thread_id TEXT,
			reply_to TEXT,
			payload TEXT,
			read INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)
	`);

	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)");

	return db;
}

export function sendMail(
	configDir: string,
	opts: {
		from: string;
		to: string;
		subject: string;
		body: string;
		type?: MailType;
		priority?: MailPriority;
		threadId?: string;
		replyTo?: string;
		payload?: Record<string, unknown>;
	},
): MailMessage {
	const store = initMailDb(configDir);
	const id = randomUUID().slice(0, 12);
	const now = new Date().toISOString();
	const threadId = opts.threadId ?? opts.replyTo ?? id;

	store
		.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, subject, body, type, priority, thread_id, reply_to, payload, read, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		)
		.run(
			id,
			opts.from,
			opts.to,
			opts.subject,
			opts.body,
			opts.type ?? "status",
			opts.priority ?? "normal",
			threadId,
			opts.replyTo ?? null,
			opts.payload ? JSON.stringify(opts.payload) : null,
			now,
		);

	return {
		id,
		from: opts.from,
		to: opts.to,
		subject: opts.subject,
		body: opts.body,
		type: opts.type ?? "status",
		priority: opts.priority ?? "normal",
		threadId,
		replyTo: opts.replyTo,
		payload: opts.payload,
		read: false,
		createdAt: now,
	};
}

export function checkMail(configDir: string, agent: string): MailMessage[] {
	const store = initMailDb(configDir);
	const rows = store
		.prepare(
			`SELECT * FROM messages WHERE to_agent = ? AND read = 0 ORDER BY
			 CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
			 created_at ASC`,
		)
		.all(agent) as Array<Record<string, unknown>>;

	return rows.map(rowToMessage);
}

export function listMail(
	configDir: string,
	opts?: { from?: string; to?: string; unread?: boolean; limit?: number },
): MailMessage[] {
	const store = initMailDb(configDir);
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts?.from) {
		conditions.push("from_agent = ?");
		params.push(opts.from);
	}
	if (opts?.to) {
		conditions.push("to_agent = ?");
		params.push(opts.to);
	}
	if (opts?.unread) {
		conditions.push("read = 0");
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = opts?.limit ?? 50;

	const rows = store
		.prepare(`SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ?`)
		.all(...params, limit) as Array<Record<string, unknown>>;

	return rows.map(rowToMessage);
}

export function markRead(configDir: string, messageId: string): void {
	const store = initMailDb(configDir);
	store.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(messageId);
}

export function replyToMail(
	configDir: string,
	messageId: string,
	from: string,
	body: string,
): MailMessage {
	const store = initMailDb(configDir);
	const original = store.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
		| Record<string, unknown>
		| undefined;

	if (!original) throw new Error(`Message ${messageId} not found`);

	return sendMail(configDir, {
		from,
		to: original.from_agent as string,
		subject: `Re: ${original.subject}`,
		body,
		type: (original.type as MailType) ?? "status",
		threadId: (original.thread_id as string) ?? messageId,
		replyTo: messageId,
	});
}

export function purgeMail(
	configDir: string,
	opts: { days?: number; agent?: string; all?: boolean },
): number {
	const store = initMailDb(configDir);

	if (opts.all) {
		const info = store.prepare("DELETE FROM messages").run();
		return info.changes;
	}

	if (opts.agent) {
		const info = store
			.prepare("DELETE FROM messages WHERE from_agent = ? OR to_agent = ?")
			.run(opts.agent, opts.agent);
		return info.changes;
	}

	if (opts.days) {
		const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
		const info = store.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
		return info.changes;
	}

	return 0;
}

export function getMailStats(configDir: string): { unread: number; total: number } {
	const store = initMailDb(configDir);
	const total = (store.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
	const unread = (
		store.prepare("SELECT COUNT(*) as c FROM messages WHERE read = 0").get() as { c: number }
	).c;
	return { unread, total };
}

function rowToMessage(row: Record<string, unknown>): MailMessage {
	return {
		id: row.id as string,
		from: row.from_agent as string,
		to: row.to_agent as string,
		subject: row.subject as string,
		body: row.body as string,
		type: row.type as MailType,
		priority: row.priority as MailPriority,
		threadId: row.thread_id as string | undefined,
		replyTo: row.reply_to as string | undefined,
		payload: row.payload ? JSON.parse(row.payload as string) : undefined,
		read: (row.read as number) === 1,
		createdAt: row.created_at as string,
	};
}

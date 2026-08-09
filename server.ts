// bb-plugin-mail — triage, escalate, and draft across multiple Gmail
// accounts over IMAP app passwords.
//
// HARD INVARIANT: this plugin never sends email. There is no SMTP client,
// no `sendMail`, and no `messages.send` call anywhere in this codebase —
// drafting only writes to the account's own Drafts folder via IMAP APPEND,
// and escalation only creates an internal bb task. See README.md.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { appendDraft, fetchMessageBody, pollInbox } from "./lib/imap";
import { buildDigest, formatDigestText, type DigestMessage } from "./lib/digest";
import { buildRawEmail, replySubject } from "./lib/mime";
import { matchesRule, triage, type Rule, type RuleAction, type RuleUrgency, type RuleMatchType } from "./lib/rules";
import { createEscalationTask } from "./lib/tasksCli";

const matchTypeSchema = z.enum(["from", "domain", "subject-contains", "list-id"]);
const actionSchema = z.enum(["escalate", "digest", "ignore"]);
const urgencySchema = z.enum(["low", "normal", "high"]);
const statusSchema = z.enum(["unhandled", "escalated", "digested", "ignored"]);

const ruleSchema = z.object({
  id: z.string(),
  matchType: matchTypeSchema,
  matchValue: z.string(),
  action: actionSchema,
  urgency: urgencySchema,
  createdAt: z.string(),
}).strict();

const messageSummarySchema = z.object({
  id: z.string(),
  account: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  receivedAt: z.string(),
  status: statusSchema,
  urgency: urgencySchema,
  ruleId: z.string().nullable(),
  taskKey: z.string().nullable(),
}).strict();

// The frontend never sends a raw SQL LIKE pattern — `query` is a plain
// substring the backend wraps itself, same as the mail_inbox agent tool.
export const rpcContract = defineRpcContract({
  listMessages: {
    input: z.object({
      account: z.string().optional(),
      status: statusSchema.optional(),
      query: z.string().optional(),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().positive().max(200).optional().default(50),
    }).strict(),
    output: z.object({
      messages: z.array(messageSummarySchema),
      total: z.number().int(),
    }).strict(),
  },
  getMessageBody: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      id: z.string(),
      account: z.string(),
      from: z.string(),
      to: z.string(),
      subject: z.string(),
      receivedAt: z.string(),
      body: z.string(),
      status: statusSchema,
      urgency: urgencySchema,
      appliedRule: ruleSchema.nullable(),
    }).strict(),
  },
  listRules: {
    input: z.null(),
    output: z.object({ rules: z.array(ruleSchema) }).strict(),
  },
  createRule: {
    input: z.object({
      matchType: matchTypeSchema,
      matchValue: z.string().trim().min(1),
      action: actionSchema,
      urgency: urgencySchema.optional().default("normal"),
    }).strict(),
    output: z.object({ rule: ruleSchema }).strict(),
  },
  updateRule: {
    input: z.object({
      id: z.string(),
      matchType: matchTypeSchema,
      matchValue: z.string().trim().min(1),
      action: actionSchema,
      urgency: urgencySchema,
    }).strict(),
    output: z.object({ rule: ruleSchema }).strict(),
  },
  deleteRule: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  previewRuleMatches: {
    input: z.object({
      matchType: matchTypeSchema,
      matchValue: z.string(),
    }).strict(),
    output: z.object({ matchCount: z.number().int(), sampleSize: z.number().int() }).strict(),
  },
  listDrafts: {
    input: z.null(),
    output: z.object({
      drafts: z.array(
        z.object({
          id: z.string(),
          messageId: z.string(),
          account: z.string(),
          subject: z.string(),
          bodyPreview: z.string(),
          createdAt: z.string(),
          threadId: z.string().nullable(),
          originalMessage: z.object({ subject: z.string(), from: z.string(), account: z.string() }).nullable(),
        }).strict(),
      ),
    }).strict(),
  },
  listAccounts: {
    input: z.null(),
    output: z.object({
      accounts: z.array(
        z.object({
          address: z.string(),
          secretName: z.string(),
          configured: z.boolean(),
          lastPolledAt: z.string().nullable(),
          lastError: z.string().nullable(),
        }).strict(),
      ),
    }).strict(),
  },
  draftReplyThread: {
    input: z.object({ messageId: z.string(), projectId: z.string().nullable() }).strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
});

interface AccountConfig {
  address: string;
  secretName: string;
}

function parseAccounts(raw: string): AccountConfig[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.address === "string" && typeof item.secretName === "string")
      .map((item) => ({ address: item.address, secretName: item.secretName }));
  } catch {
    return [];
  }
}

function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    accounts: {
      type: "string",
      label: "Gmail accounts (JSON list of {address, secretName})",
      default: "[]",
    },
    pollIntervalMinutes: {
      type: "string",
      label: "Poll interval (minutes)",
      default: "5",
    },
    gmailAppPasswordPrimary: { type: "string", label: "Gmail app password (primary account)", secret: true },
    gmailAppPasswordSecondary: { type: "string", label: "Gmail app password (secondary account)", secret: true },
    gmailAppPasswordTertiary: { type: "string", label: "Gmail app password (tertiary account)", secret: true },
    gmailAppPasswordQuaternary: { type: "string", label: "Gmail app password (quaternary account)", secret: true },
    gmailAppPasswordQuinary: { type: "string", label: "Gmail app password (quinary account)", secret: true },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      match_type TEXT NOT NULL,
      match_value TEXT NOT NULL,
      action TEXT NOT NULL,
      urgency TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      from_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      list_id TEXT,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unhandled',
      urgency TEXT NOT NULL DEFAULT 'normal',
      rule_id TEXT,
      task_key TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS messages_account_uid ON messages(account, uid)`,
    `CREATE TABLE IF NOT EXISTS account_cursors (
      account TEXT PRIMARY KEY,
      last_uid INTEGER NOT NULL DEFAULT 0
    )`,
    `ALTER TABLE account_cursors ADD COLUMN last_polled_at TEXT`,
    `ALTER TABLE account_cursors ADD COLUMN last_error TEXT`,
    `CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      account TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    )`,
  ]);

  function loadRules(): Rule[] {
    const rows = db
      .prepare(`SELECT id, match_type, match_value, action, urgency, created_at FROM rules ORDER BY created_at ASC`)
      .all() as Array<{
      id: string;
      match_type: RuleMatchType;
      match_value: string;
      action: RuleAction;
      urgency: RuleUrgency;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      matchType: r.match_type,
      matchValue: r.match_value,
      action: r.action,
      urgency: r.urgency,
      createdAt: r.created_at,
    }));
  }

  async function resolveAccounts(): Promise<Array<{ address: string; appPassword: string }>> {
    const values = await settings.get();
    const configured = parseAccounts(values.accounts ?? "[]");
    const bySlotKey: Record<string, string | undefined> = {
      gmailAppPasswordPrimary: values.gmailAppPasswordPrimary,
      gmailAppPasswordSecondary: values.gmailAppPasswordSecondary,
      gmailAppPasswordTertiary: values.gmailAppPasswordTertiary,
      gmailAppPasswordQuaternary: values.gmailAppPasswordQuaternary,
      gmailAppPasswordQuinary: values.gmailAppPasswordQuinary,
    };
    const resolved: Array<{ address: string; appPassword: string }> = [];
    for (const account of configured) {
      const appPassword = bySlotKey[account.secretName];
      if (appPassword) resolved.push({ address: account.address, appPassword });
    }
    return resolved;
  }

  function messageRowToDigest(row: any): DigestMessage {
    return {
      id: row.id,
      account: row.account,
      from: row.from_address,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.received_at,
      status: row.status,
      urgency: row.urgency,
      taskKey: row.task_key,
    };
  }

  function rowToMessageSummary(row: any) {
    return {
      id: row.id,
      account: row.account,
      from: row.from_address,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.received_at,
      status: row.status,
      urgency: row.urgency,
      ruleId: row.rule_id,
      taskKey: row.task_key,
    };
  }

  function rowToRule(row: any): Rule {
    return {
      id: row.id,
      matchType: row.match_type,
      matchValue: row.match_value,
      action: row.action,
      urgency: row.urgency,
      createdAt: row.created_at,
    };
  }

  async function pollOnce(): Promise<void> {
    const accounts = await resolveAccounts();
    if (accounts.length === 0) {
      throw Object.assign(new Error("Configure at least one Gmail account (address + app password secret) before polling."), {
        name: "NeedsConfigurationError",
      });
    }
    const rules = loadRules();
    let anyNewMessages = false;
    for (const account of accounts) {
      try {
        const cursorRow = db.prepare(`SELECT last_uid FROM account_cursors WHERE account = ?`).get(account.address) as
          | { last_uid: number }
          | undefined;
        const lastUid = cursorRow?.last_uid ?? 0;
        const fetched = await pollInbox(account, lastUid);
        if (fetched.length > 0) anyNewMessages = true;
        let maxUid = lastUid;
        for (const message of fetched) {
          maxUid = Math.max(maxUid, message.uid);
          const id = `${account.address}:${message.uid}`;
          const result = triage(
            { from: message.from, subject: message.subject, listId: message.listId },
            rules,
          );
          let taskKey: string | null = null;
          let status: "unhandled" | "escalated" | "digested" | "ignored" = "digested";
          if (result.action === "escalate") {
            status = "escalated";
            taskKey = await createEscalationTask({
              subject: message.subject,
              from: message.from,
              account: account.address,
              snippet: message.snippet,
              urgency: result.urgency,
              linkId: id,
            }).catch((err) => {
              bb.log.error(`escalation task creation failed for ${id}: ${err}`);
              return null;
            });
          } else if (result.action === "ignore") {
            status = "ignored";
          } else {
            status = "unhandled";
          }
          db.prepare(
            `INSERT OR REPLACE INTO messages
              (id, account, uid, message_id, from_address, subject, snippet, list_id, received_at, status, urgency, rule_id, task_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            account.address,
            message.uid,
            message.messageId,
            message.from,
            message.subject,
            message.snippet,
            message.listId,
            message.receivedAt,
            status,
            result.urgency,
            result.rule?.id ?? null,
            taskKey,
            new Date().toISOString(),
          );
        }
        db.prepare(
          `INSERT INTO account_cursors (account, last_uid, last_polled_at, last_error) VALUES (?, ?, ?, NULL)
           ON CONFLICT(account) DO UPDATE SET last_uid = excluded.last_uid, last_polled_at = excluded.last_polled_at, last_error = NULL`,
        ).run(account.address, maxUid, new Date().toISOString());
      } catch (err) {
        bb.log.error(`poll failed for ${account.address}: ${err}`);
        db.prepare(
          `INSERT INTO account_cursors (account, last_uid, last_polled_at, last_error) VALUES (?, 0, ?, ?)
           ON CONFLICT(account) DO UPDATE SET last_polled_at = excluded.last_polled_at, last_error = excluded.last_error`,
        ).run(account.address, new Date().toISOString(), String(err));
      }
    }
    if (anyNewMessages) bb.realtime.publish("messages-changed", { reason: "new-mail" });
  }

  const initial = await settings.get();
  if (parseAccounts(initial.accounts ?? "[]").length === 0) {
    bb.status.needsConfiguration(
      "Add at least one Gmail account to the `accounts` setting and its app password secret, then reload.",
    );
  }

  bb.rpc.register(rpcContract, {
    listMessages({ account, status, query, offset, limit }) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (account) {
        clauses.push("account = ?");
        params.push(account);
      }
      if (status) {
        clauses.push("status = ?");
        params.push(status);
      }
      if (query) {
        clauses.push("(subject LIKE ? OR from_address LIKE ? OR snippet LIKE ?)");
        const like = `%${query}%`;
        params.push(like, like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const total = (
        db.prepare(`SELECT COUNT(*) AS count FROM messages ${where}`).get(...params) as { count: number }
      ).count;
      const rows = db
        .prepare(`SELECT * FROM messages ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
      return { messages: rows.map(rowToMessageSummary), total };
    },
    async getMessageBody({ id }) {
      const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as any;
      if (!row) throw new Error(`No such message: ${id}`);
      const accounts = await resolveAccounts();
      const account = accounts.find((a) => a.address === row.account);
      if (!account) throw new Error(`Account not configured: ${row.account}`);
      const body = await fetchMessageBody(account, row.uid);
      const rules = loadRules();
      const appliedRule = row.rule_id ? (rules.find((r) => r.id === row.rule_id) ?? null) : null;
      return {
        id: row.id,
        account: row.account,
        from: row.from_address,
        to: body?.to ?? "",
        subject: row.subject,
        receivedAt: row.received_at,
        body: body?.text ?? "",
        status: row.status,
        urgency: row.urgency,
        appliedRule,
      };
    },
    listRules() {
      return { rules: loadRules() };
    },
    createRule({ matchType, matchValue, action, urgency }) {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO rules (id, match_type, match_value, action, urgency, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, matchType, matchValue, action, urgency, createdAt);
      bb.realtime.publish("rules-changed", { reason: "created" });
      return { rule: { id, matchType, matchValue, action, urgency, createdAt } };
    },
    updateRule({ id, matchType, matchValue, action, urgency }) {
      const info = db
        .prepare(`UPDATE rules SET match_type = ?, match_value = ?, action = ?, urgency = ? WHERE id = ?`)
        .run(matchType, matchValue, action, urgency, id);
      if (info.changes === 0) throw new Error(`No such rule: ${id}`);
      const row = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as any;
      bb.realtime.publish("rules-changed", { reason: "updated" });
      return { rule: rowToRule(row) };
    },
    deleteRule({ id }) {
      const info = db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
      if (info.changes === 0) throw new Error(`No such rule: ${id}`);
      bb.realtime.publish("rules-changed", { reason: "deleted" });
      return { ok: true as const };
    },
    previewRuleMatches({ matchType, matchValue }) {
      const rows = db
        .prepare(`SELECT from_address, subject, list_id FROM messages ORDER BY received_at DESC LIMIT 200`)
        .all() as Array<{ from_address: string; subject: string; list_id: string | null }>;
      const candidate: Rule = { id: "preview", matchType, matchValue, action: "digest", urgency: "normal", createdAt: "" };
      const matchCount = rows.filter((r) =>
        matchesRule({ from: r.from_address, subject: r.subject, listId: r.list_id }, candidate),
      ).length;
      return { matchCount, sampleSize: rows.length };
    },
    listDrafts() {
      const rows = db
        .prepare(
          `SELECT d.*, m.subject AS orig_subject, m.from_address AS orig_from, m.account AS orig_account
           FROM drafts d LEFT JOIN messages m ON m.id = d.message_id
           ORDER BY d.created_at DESC`,
        )
        .all() as any[];
      return {
        drafts: rows.map((row) => ({
          id: row.id,
          messageId: row.message_id,
          account: row.account,
          subject: row.subject,
          bodyPreview: row.body.length > 200 ? `${row.body.slice(0, 200)}…` : row.body,
          createdAt: row.created_at,
          threadId: row.thread_id ?? null,
          originalMessage:
            row.orig_subject != null
              ? { subject: row.orig_subject, from: row.orig_from, account: row.orig_account }
              : null,
        })),
      };
    },
    async listAccounts() {
      const values = await settings.get();
      const configured = parseAccounts(values.accounts ?? "[]");
      const bySlotKey: Record<string, string | undefined> = {
        gmailAppPasswordPrimary: values.gmailAppPasswordPrimary,
        gmailAppPasswordSecondary: values.gmailAppPasswordSecondary,
        gmailAppPasswordTertiary: values.gmailAppPasswordTertiary,
        gmailAppPasswordQuaternary: values.gmailAppPasswordQuaternary,
        gmailAppPasswordQuinary: values.gmailAppPasswordQuinary,
      };
      const cursors = db.prepare(`SELECT account, last_polled_at, last_error FROM account_cursors`).all() as Array<{
        account: string;
        last_polled_at: string | null;
        last_error: string | null;
      }>;
      const cursorByAccount = new Map(cursors.map((c) => [c.account, c]));
      return {
        accounts: configured.map((account) => ({
          address: account.address,
          secretName: account.secretName,
          configured: Boolean(bySlotKey[account.secretName]),
          lastPolledAt: cursorByAccount.get(account.address)?.last_polled_at ?? null,
          lastError: cursorByAccount.get(account.address)?.last_error ?? null,
        })),
      };
    },
    async draftReplyThread({ messageId, projectId }) {
      const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as any;
      if (!row) throw new Error(`No such message: ${messageId}`);

      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        const personal = projects.find((p) => p.kind === "personal") ?? projects[0];
        if (!personal) throw new Error("No project available to host the reply thread.");
        resolvedProjectId = personal.id;
      }

      const prompt = [
        "Compose a reply to this email and save it as a Gmail draft. Never send it — bb never sends mail.",
        "",
        `Account: ${row.account}`,
        `From: ${row.from_address}`,
        `Subject: ${row.subject}`,
        `Snippet: ${row.snippet}`,
        "",
        "Read the full message with the mail_inbox tool or `bb mail digest` if you need more context, draft a" +
          " reply body, and save it (never send it) by running:",
        `  bb mail draft ${row.id} --body "<your reply text>"`,
        "That appends the draft into the account's own Gmail Drafts folder for a human to review and send.",
      ].join("\n");

      const thread = await bb.sdk.threads.spawn({
        projectId: resolvedProjectId,
        environment: { type: "project-default" },
        prompt,
        title: `Draft reply: ${row.subject || "(no subject)"}`,
      });
      return { threadId: thread.id };
    },
  });

  bb.background.service("poller", {
    async start(signal) {
      while (!signal.aborted) {
        await pollOnce().catch((err) => {
          if (err?.name === "NeedsConfigurationError") throw err;
          bb.log.error(`poll cycle failed: ${err}`);
        });
        const values = await settings.get();
        const minutes = Number.parseInt(values.pollIntervalMinutes ?? "5", 10) || 5;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, minutes * 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  });

  bb.cli.register({
    name: "mail",
    summary: "Triage, escalate, and draft replies across Gmail accounts (never sends mail).",
    commands: [
      {
        name: "rule-add",
        summary: "Add a triage rule",
        usage:
          "bb mail rule add --match-type <from|domain|subject-contains|list-id> --match-value <value> --action <escalate|digest|ignore> [--urgency <low|normal|high>]",
      },
      { name: "rule-list", summary: "List triage rules", usage: "bb mail rule list" },
      { name: "rule-rm", summary: "Remove a triage rule", usage: "bb mail rule rm <rule-id>" },
      {
        name: "digest",
        summary: "Print grouped unhandled mail",
        usage: "bb mail digest [--since <ISO-date>]",
      },
      {
        name: "draft",
        summary: "Save a reply draft to the account's Drafts folder (never sends)",
        usage: "bb mail draft <message-id> --body <text> | --body-file <path>",
      },
    ],
    async run(argv, ctx) {
      const [sub, sub2, ...rest] = argv;

      if (sub === "rule" && sub2 === "add") {
        const { flags } = parseFlags(rest);
        const matchType = flags["match-type"] as RuleMatchType | undefined;
        const matchValue = flags["match-value"];
        const action = flags["action"] as RuleAction | undefined;
        const urgency = (flags["urgency"] as RuleUrgency | undefined) ?? "normal";
        if (!matchType || !matchValue || !action) {
          return { exitCode: 1, stderr: "Usage: bb mail rule add --match-type <..> --match-value <..> --action <..> [--urgency <..>]\n" };
        }
        if (!["from", "domain", "subject-contains", "list-id"].includes(matchType)) {
          return { exitCode: 1, stderr: `Invalid --match-type: ${matchType}\n` };
        }
        if (!["escalate", "digest", "ignore"].includes(action)) {
          return { exitCode: 1, stderr: `Invalid --action: ${action}\n` };
        }
        const id = randomUUID();
        db.prepare(
          `INSERT INTO rules (id, match_type, match_value, action, urgency, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, matchType, matchValue, action, urgency, new Date().toISOString());
        bb.realtime.publish("rules-changed", { reason: "created" });
        return { exitCode: 0, stdout: `Rule ${id} added.\n` };
      }

      if (sub === "rule" && sub2 === "list") {
        const rules = loadRules();
        if (rules.length === 0) return { exitCode: 0, stdout: "No rules configured.\n" };
        const lines = rules.map(
          (r) => `${r.id}  ${r.matchType}=${r.matchValue}  action=${r.action}  urgency=${r.urgency}`,
        );
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }

      if (sub === "rule" && sub2 === "rm") {
        const ruleId = rest[0];
        if (!ruleId) return { exitCode: 1, stderr: "Usage: bb mail rule rm <rule-id>\n" };
        const info = db.prepare(`DELETE FROM rules WHERE id = ?`).run(ruleId);
        if (info.changes > 0) bb.realtime.publish("rules-changed", { reason: "deleted" });
        return info.changes > 0
          ? { exitCode: 0, stdout: `Rule ${ruleId} removed.\n` }
          : { exitCode: 1, stderr: `No such rule: ${ruleId}\n` };
      }

      if (sub === "digest") {
        const { flags } = parseFlags(argv.slice(1));
        const since = flags["since"] ?? null;
        const rows = db.prepare(`SELECT * FROM messages WHERE status != 'ignored' ORDER BY received_at DESC`).all();
        const digest = buildDigest(rows.map(messageRowToDigest), since);
        return { exitCode: 0, stdout: formatDigestText(digest) + "\n" };
      }

      if (sub === "draft") {
        const messageDbId = sub2;
        const { flags } = parseFlags(rest);
        if (!messageDbId) return { exitCode: 1, stderr: "Usage: bb mail draft <message-id> --body <text> | --body-file <path>\n" };
        let body = flags["body"];
        if (!body && flags["body-file"]) {
          body = await readFile(flags["body-file"], "utf8");
        }
        if (!body) return { exitCode: 1, stderr: "Provide --body or --body-file.\n" };

        const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageDbId) as any;
        if (!row) return { exitCode: 1, stderr: `No such message: ${messageDbId}\n` };

        const accounts = await resolveAccounts();
        const account = accounts.find((a) => a.address === row.account);
        if (!account) return { exitCode: 1, stderr: `Account not configured: ${row.account}\n` };

        const raw = buildRawEmail({
          from: account.address,
          to: row.from_address,
          subject: replySubject(row.subject),
          body,
          inReplyTo: row.message_id,
          references: row.message_id,
          messageId: `<${randomUUID()}@bb-plugin-mail>`,
          date: new Date().toUTCString(),
        });
        await appendDraft(account, raw);
        db.prepare(
          `INSERT INTO drafts (id, message_id, account, subject, body, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), row.id, account.address, replySubject(row.subject), body, ctx?.threadId ?? null, new Date().toISOString());
        bb.realtime.publish("drafts-changed", { reason: "created" });
        return { exitCode: 0, stdout: `Draft saved to ${account.address}'s [Gmail]/Drafts.\n` };
      }

      return { exitCode: 1, stderr: "Unknown subcommand. See `bb mail --help`.\n" };
    },
  });

  bb.agents.registerTool({
    name: "mail_inbox",
    description: "Read triage state for polled mail (never sends anything).",
    parameters: z.object({
      query: z.string().optional().describe("Substring match against subject/from/snippet"),
      account: z.string().optional().describe("Filter to one account address"),
      limit: z.number().int().positive().max(200).optional().default(20),
    }),
    async execute({ query, account, limit }) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (account) {
        clauses.push("account = ?");
        params.push(account);
      }
      if (query) {
        clauses.push("(subject LIKE ? OR from_address LIKE ? OR snippet LIKE ?)");
        const like = `%${query}%`;
        params.push(like, like, like);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM messages ${where} ORDER BY received_at DESC LIMIT ?`)
        .all(...params, limit ?? 20);
      return JSON.stringify(rows.map(messageRowToDigest));
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

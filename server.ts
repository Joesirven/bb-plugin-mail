// bb-plugin-mail — triage, escalate, and draft across multiple Gmail
// accounts over IMAP app passwords.
//
// HARD INVARIANT: this plugin never sends email. There is no SMTP client,
// no `sendMail`, and no `messages.send` call anywhere in this codebase —
// drafting only writes to the account's own Drafts folder via IMAP APPEND,
// and escalation only creates an internal bb task. See README.md.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { appendDraft, pollInbox } from "./lib/imap";
import { buildDigest, formatDigestText, type DigestMessage } from "./lib/digest";
import { buildRawEmail, replySubject } from "./lib/mime";
import { triage, type Rule, type RuleAction, type RuleUrgency, type RuleMatchType } from "./lib/rules";
import { createEscalationTask } from "./lib/tasksCli";

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

  async function pollOnce(): Promise<void> {
    const accounts = await resolveAccounts();
    if (accounts.length === 0) {
      throw Object.assign(new Error("Configure at least one Gmail account (address + app password secret) before polling."), {
        name: "NeedsConfigurationError",
      });
    }
    const rules = loadRules();
    for (const account of accounts) {
      try {
        const cursorRow = db.prepare(`SELECT last_uid FROM account_cursors WHERE account = ?`).get(account.address) as
          | { last_uid: number }
          | undefined;
        const lastUid = cursorRow?.last_uid ?? 0;
        const fetched = await pollInbox(account, lastUid);
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
          `INSERT INTO account_cursors (account, last_uid) VALUES (?, ?)
           ON CONFLICT(account) DO UPDATE SET last_uid = excluded.last_uid`,
        ).run(account.address, maxUid);
      } catch (err) {
        bb.log.error(`poll failed for ${account.address}: ${err}`);
      }
    }
  }

  const initial = await settings.get();
  if (parseAccounts(initial.accounts ?? "[]").length === 0) {
    bb.status.needsConfiguration(
      "Add at least one Gmail account to the `accounts` setting and its app password secret, then reload.",
    );
  }

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
    async run(argv) {
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

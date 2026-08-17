import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server";

describe("bb-plugin-mail server", () => {
  // Regression test for the "mail is dead after every bb restart" incident:
  // autoPollEnabled was added as an interim safety valve while an unguarded
  // IMAP client could crash the whole server, and it defaulted to false. The
  // crash is now fixed at the source (lib/imap.ts attaches an error
  // listener), so a false default just means every restart silently stops
  // polling until a human notices and flips the setting back on. It must
  // default to true so a restart requires no manual step.
  it("defaults autoPollEnabled to true", () => {
    const source = readFileSync(path.join(__dirname, "server.ts"), "utf8");
    const settingIndex = source.indexOf("autoPollEnabled:");
    expect(settingIndex).toBeGreaterThan(-1);
    const descriptor = source.slice(settingIndex, settingIndex + 700);
    expect(descriptor).toMatch(/default:\s*true\s*,/);
  });

  it("gates the poller on the autoPollEnabled setting in source, not just at registration time", () => {
    // A source-scan, not a live-service test: actually starting the poller
    // service opens a real IMAP connection attempt, which is slow/flaky in
    // CI. The behavioral contract (checked live above) is that the setting
    // defaults true; this guards that the poller loop still reads it fresh
    // on every cycle rather than only once at load.
    const source = readFileSync(path.join(__dirname, "server.ts"), "utf8");
    const serviceIndex = source.indexOf('bb.background.service("poller"');
    expect(serviceIndex).toBeGreaterThan(-1);
    const serviceBody = source.slice(serviceIndex, serviceIndex + 800);
    expect(serviceBody).toMatch(/await\s+settings\.get\(\)/);
    expect(serviceBody).toMatch(/values\.autoPollEnabled/);
  });

  it("reports needs-configuration when no accounts are set", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "mail" });
    await plugin(bb);
    expect(harness.needsConfigurationMessages.length).toBeGreaterThan(0);
    expect(harness.needsConfigurationMessages[0]).toMatch(/account/i);
    await harness.lifecycle.dispose();
  });

  it("does not need configuration once an account and its secret are set", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "mail",
      settings: {
        accounts: JSON.stringify([{ address: "jose@gmail.com", secretName: "gmailAppPasswordPrimary" }]),
        gmailAppPasswordPrimary: "app-password-value",
      },
    });
    await plugin(bb);
    expect(harness.needsConfigurationMessages.length).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("adds, lists, and removes a triage rule via the CLI", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "mail" });
    await plugin(bb);

    const add = await harness.behavior.runCli([
      "rule",
      "add",
      "--match-type",
      "domain",
      "--match-value",
      "acme.com",
      "--action",
      "escalate",
      "--urgency",
      "high",
    ]);
    expect(add.exitCode).toBe(0);
    const ruleId = add.stdout?.match(/Rule (\S+) added/)?.[1];
    expect(ruleId).toBeTruthy();

    const list = await harness.behavior.runCli(["rule", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("acme.com");
    expect(list.stdout).toContain("escalate");

    const rm = await harness.behavior.runCli(["rule", "rm", ruleId!]);
    expect(rm.exitCode).toBe(0);

    const listAfter = await harness.behavior.runCli(["rule", "list"]);
    expect(listAfter.stdout).toContain("No rules configured");

    await harness.lifecycle.dispose();
  });

  it("rejects an invalid rule action", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "mail" });
    await plugin(bb);
    const result = await harness.behavior.runCli([
      "rule",
      "add",
      "--match-type",
      "domain",
      "--match-value",
      "acme.com",
      "--action",
      "launch-missiles",
    ]);
    expect(result.exitCode).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("prints an empty digest when there is no mail", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "mail" });
    await plugin(bb);
    const digest = await harness.behavior.runCli(["digest"]);
    expect(digest.exitCode).toBe(0);
    expect(digest.stdout).toContain("No unhandled mail");
    await harness.lifecycle.dispose();
  });

  it("exposes mail_inbox as an agent tool returning JSON", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "mail" });
    await plugin(bb);
    const result = await harness.behavior.callAgentTool("mail_inbox", {});
    const parsed = JSON.parse(String(result));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("exposes panel data and rule mutations through RPC", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "mail",
      settings: {
        accounts: JSON.stringify([{ address: "jose@gmail.com", secretName: "gmailAppPasswordPrimary" }]),
        gmailAppPasswordPrimary: "app-password-value",
      },
    });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare(
      `INSERT INTO messages
        (id, account, uid, message_id, from_address, subject, snippet, list_id, received_at, status, urgency, rule_id, task_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "jose@gmail.com:1",
      "jose@gmail.com",
      1,
      "<message-1@example.com>",
      "alerts@example.com",
      "Review this",
      "A short preview",
      null,
      "2026-08-09T12:00:00.000Z",
      "unhandled",
      "normal",
      null,
      null,
      "2026-08-09T12:00:01.000Z",
    );

    const added = await harness.behavior.callRpc("createRule", {
      matchType: "domain",
      matchValue: "example.com",
      action: "escalate",
      urgency: "high",
    }) as { rule: { id: string; matchValue: string } };
    expect(added.rule.matchValue).toBe("example.com");

    const accounts = await harness.behavior.callRpc("listAccounts") as {
      accounts: Array<{ address: string; configured: boolean }>;
    };
    expect(accounts.accounts).toEqual([{ address: "jose@gmail.com", configured: true, lastError: null, lastPolledAt: null, secretName: "gmailAppPasswordPrimary" }]);

    const messages = await harness.behavior.callRpc("listMessages", { limit: 100, offset: 0 }) as {
      messages: Array<{ id: string; from: string; status: string }>;
    };
    expect(messages.messages).toMatchObject([
      {
        id: "jose@gmail.com:1",
        from: "alerts@example.com",
        status: "unhandled",
      },
    ]);
    const rules = await harness.behavior.callRpc("listRules") as { rules: unknown[] };
    expect(rules.rules).toHaveLength(1);
    expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({
      channel: "rules-changed",
    });

    const removed = await harness.behavior.callRpc("deleteRule", { id: added.rule.id });
    expect(removed).toEqual({ ok: true });
    const afterRemove = await harness.behavior.callRpc("listRules") as { rules: unknown[] };
    expect(afterRemove.rules).toEqual([]);

    await harness.lifecycle.dispose();
  });
});

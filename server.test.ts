import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server";

describe("bb-plugin-mail server", () => {
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
});

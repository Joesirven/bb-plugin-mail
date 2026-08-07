import { describe, expect, it } from "vitest";
import { matchesRule, triage, type Rule } from "./rules";

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: overrides.id ?? "r1",
    matchType: overrides.matchType ?? "from",
    matchValue: overrides.matchValue ?? "",
    action: overrides.action ?? "digest",
    urgency: overrides.urgency ?? "normal",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("matchesRule", () => {
  it("matches an exact sender address, case-insensitively", () => {
    const r = rule({ matchType: "from", matchValue: "Boss@Example.com" });
    expect(matchesRule({ from: "boss@example.com", subject: "hi" }, r)).toBe(true);
    expect(matchesRule({ from: "notboss@example.com", subject: "hi" }, r)).toBe(false);
  });

  it("matches a sender's domain regardless of local part", () => {
    const r = rule({ matchType: "domain", matchValue: "acme.com" });
    expect(matchesRule({ from: "anyone@acme.com", subject: "hi" }, r)).toBe(true);
    expect(matchesRule({ from: "anyone@other.com", subject: "hi" }, r)).toBe(false);
  });

  it("matches a domain rule written with a leading @", () => {
    const r = rule({ matchType: "domain", matchValue: "@acme.com" });
    expect(matchesRule({ from: "anyone@acme.com", subject: "hi" }, r)).toBe(true);
  });

  it("matches subject substrings case-insensitively", () => {
    const r = rule({ matchType: "subject-contains", matchValue: "invoice" });
    expect(matchesRule({ from: "a@b.com", subject: "Your INVOICE is ready" }, r)).toBe(true);
    expect(matchesRule({ from: "a@b.com", subject: "Nothing here" }, r)).toBe(false);
  });

  it("matches list-id exactly", () => {
    const r = rule({ matchType: "list-id", matchValue: "<updates.example.com>" });
    expect(matchesRule({ from: "a@b.com", subject: "s", listId: "<updates.example.com>" }, r)).toBe(true);
    expect(matchesRule({ from: "a@b.com", subject: "s", listId: null }, r)).toBe(false);
  });

  it("never matches an empty match value", () => {
    const r = rule({ matchType: "subject-contains", matchValue: "   " });
    expect(matchesRule({ from: "a@b.com", subject: "anything" }, r)).toBe(false);
  });
});

describe("triage", () => {
  it("returns the first matching rule in order", () => {
    const rules = [
      rule({ id: "r-domain", matchType: "domain", matchValue: "acme.com", action: "digest" }),
      rule({ id: "r-from", matchType: "from", matchValue: "vip@acme.com", action: "escalate", urgency: "high" }),
    ];
    const result = triage({ from: "vip@acme.com", subject: "hi" }, rules);
    expect(result.rule?.id).toBe("r-domain");
    expect(result.action).toBe("digest");
  });

  it("falls back to digest/normal when nothing matches, without losing the message", () => {
    const result = triage({ from: "stranger@nowhere.com", subject: "hi" }, []);
    expect(result.rule).toBeNull();
    expect(result.action).toBe("digest");
    expect(result.urgency).toBe("normal");
  });

  it("escalates when a rule says so", () => {
    const rules = [rule({ matchType: "from", matchValue: "vip@acme.com", action: "escalate", urgency: "high" })];
    const result = triage({ from: "vip@acme.com", subject: "hi" }, rules);
    expect(result.action).toBe("escalate");
    expect(result.urgency).toBe("high");
  });

  it("ignores when a rule says so", () => {
    const rules = [rule({ matchType: "domain", matchValue: "spam.com", action: "ignore" })];
    const result = triage({ from: "x@spam.com", subject: "hi" }, rules);
    expect(result.action).toBe("ignore");
  });
});

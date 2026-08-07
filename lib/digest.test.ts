import { describe, expect, it } from "vitest";
import { buildDigest, formatDigestText, type DigestMessage } from "./digest";

const FIXTURES: DigestMessage[] = [
  {
    id: "a1",
    account: "jose@gmail.com",
    from: "boss@acme.com",
    subject: "Quarterly numbers",
    snippet: "Can you review before Friday?",
    receivedAt: "2026-08-05T10:00:00.000Z",
    status: "escalated",
    urgency: "high",
    taskKey: "MAIL-1",
  },
  {
    id: "a2",
    account: "jose@gmail.com",
    from: "newsletter@example.com",
    subject: "Weekly digest",
    snippet: "Top stories this week",
    receivedAt: "2026-08-06T09:00:00.000Z",
    status: "unhandled",
    urgency: "normal",
  },
  {
    id: "b1",
    account: "work@sirven.xyz",
    from: "spam@sale.com",
    subject: "50% off",
    snippet: "Limited time",
    receivedAt: "2026-08-06T08:00:00.000Z",
    status: "ignored",
    urgency: "low",
  },
  {
    id: "b2",
    account: "work@sirven.xyz",
    from: "client@partner.com",
    subject: "Contract question",
    snippet: "One quick thing",
    receivedAt: "2026-08-01T08:00:00.000Z",
    status: "unhandled",
    urgency: "normal",
  },
];

describe("buildDigest", () => {
  it("groups by account, newest first, and excludes ignored mail", () => {
    const digest = buildDigest(FIXTURES);
    expect(digest.totalCount).toBe(3);
    expect(digest.accounts.map((g) => g.account)).toEqual(["jose@gmail.com", "work@sirven.xyz"]);

    const jose = digest.accounts.find((g) => g.account === "jose@gmail.com")!;
    expect(jose.messages.map((m) => m.id)).toEqual(["a2", "a1"]);

    const work = digest.accounts.find((g) => g.account === "work@sirven.xyz")!;
    expect(work.messages.map((m) => m.id)).toEqual(["b2"]);
  });

  it("filters to messages received at or after `since`", () => {
    const digest = buildDigest(FIXTURES, "2026-08-05T00:00:00.000Z");
    const ids = digest.accounts.flatMap((g) => g.messages.map((m) => m.id));
    expect(ids.sort()).toEqual(["a1", "a2"]);
  });

  it("returns an empty digest when nothing qualifies", () => {
    const digest = buildDigest([], null);
    expect(digest.totalCount).toBe(0);
    expect(digest.accounts).toEqual([]);
  });
});

describe("formatDigestText", () => {
  it("reports no unhandled mail when the digest is empty", () => {
    expect(formatDigestText(buildDigest([]))).toBe("No unhandled mail.");
  });

  it("renders grouped, human-readable output", () => {
    const text = formatDigestText(buildDigest(FIXTURES));
    expect(text).toContain("jose@gmail.com (2)");
    expect(text).toContain("work@sirven.xyz (1)");
    expect(text).toContain("[high]");
    expect(text).toContain("MAIL-1");
    expect(text).not.toContain("spam@sale.com");
  });
});

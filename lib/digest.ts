// Pure digest-grouping logic — no I/O, unit-testable with fixture data.

export interface DigestMessage {
  id: string;
  account: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string; // ISO 8601
  status: "unhandled" | "escalated" | "digested" | "ignored";
  urgency: "low" | "normal" | "high";
  taskKey?: string | null;
}

export interface DigestAccountGroup {
  account: string;
  messages: DigestMessage[];
}

export interface Digest {
  since: string | null;
  totalCount: number;
  accounts: DigestAccountGroup[];
}

// Groups unhandled/escalated mail (never "ignored") by account, newest
// first within each account, optionally filtered to messages received at or
// after `since`. Ignored messages are excluded — that is what "ignore" means.
export function buildDigest(messages: DigestMessage[], since?: string | null): Digest {
  const cutoff = since ? Date.parse(since) : null;
  const relevant = messages.filter((m) => {
    if (m.status === "ignored") return false;
    if (cutoff !== null && Date.parse(m.receivedAt) < cutoff) return false;
    return true;
  });

  const byAccount = new Map<string, DigestMessage[]>();
  for (const message of relevant) {
    const bucket = byAccount.get(message.account);
    if (bucket) bucket.push(message);
    else byAccount.set(message.account, [message]);
  }

  const accounts: DigestAccountGroup[] = Array.from(byAccount.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, msgs]) => ({
      account,
      messages: [...msgs].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)),
    }));

  return { since: since ?? null, totalCount: relevant.length, accounts };
}

export function formatDigestText(digest: Digest): string {
  if (digest.totalCount === 0) {
    return digest.since
      ? `No unhandled mail since ${digest.since}.`
      : "No unhandled mail.";
  }
  const lines: string[] = [];
  lines.push(
    digest.since
      ? `Mail digest since ${digest.since} — ${digest.totalCount} message(s)`
      : `Mail digest — ${digest.totalCount} message(s)`,
  );
  for (const group of digest.accounts) {
    lines.push("");
    lines.push(`${group.account} (${group.messages.length})`);
    for (const message of group.messages) {
      const urgencyTag = message.urgency === "normal" ? "" : ` [${message.urgency}]`;
      const taskTag = message.taskKey ? ` (${message.taskKey})` : "";
      lines.push(`  - ${message.receivedAt} ${message.from} — ${message.subject}${urgencyTag}${taskTag}`);
      if (message.snippet) lines.push(`      ${message.snippet}`);
    }
  }
  return lines.join("\n");
}

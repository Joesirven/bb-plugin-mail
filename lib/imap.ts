// Thin IMAP wrapper used by the poller and the draft command. Read + APPEND
// only — there is no SMTP client and no send/submit call anywhere in this
// module or the rest of the plugin.

import { ImapFlow } from "imapflow";

export interface ImapAccount {
  address: string;
  appPassword: string;
  host?: string;
  port?: number;
}

export interface FetchedMessage {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  listId: string | null;
  receivedAt: string;
  snippet: string;
}

function client(account: ImapAccount): ImapFlow {
  return new ImapFlow({
    host: account.host ?? "imap.gmail.com",
    port: account.port ?? 993,
    secure: true,
    auth: { user: account.address, pass: account.appPassword },
    logger: false,
  });
}

// Pulls messages with UID greater than `sinceUid` from INBOX. Only headers
// and a short preview are fetched here — full bodies are fetched on demand
// elsewhere, never during the routine poll.
export async function pollInbox(account: ImapAccount, sinceUid: number): Promise<FetchedMessage[]> {
  const c = client(account);
  await c.connect();
  try {
    const lock = await c.getMailboxLock("INBOX");
    const results: FetchedMessage[] = [];
    try {
      const range = `${sinceUid + 1}:*`;
      for await (const msg of c.fetch(
        { uid: range },
        { envelope: true, uid: true, internalDate: true, bodyStructure: false, source: false },
      )) {
        if (msg.uid <= sinceUid) continue;
        const envelope = msg.envelope;
        const from = envelope?.from?.[0]?.address ?? "unknown";
        results.push({
          uid: msg.uid,
          messageId: envelope?.messageId ?? null,
          from,
          subject: envelope?.subject ?? "(no subject)",
          listId: null,
          receivedAt: new Date(msg.internalDate ?? Date.now()).toISOString(),
          snippet: "",
        });
      }
    } finally {
      lock.release();
    }
    return results;
  } finally {
    await c.logout();
  }
}

// Appends a raw RFC 822 message to the account's Drafts folder — storage
// only, never transmission.
export async function appendDraft(account: ImapAccount, rawMessage: string): Promise<void> {
  const c = client(account);
  await c.connect();
  try {
    await c.append("[Gmail]/Drafts", rawMessage, ["\\Draft"]);
  } finally {
    await c.logout();
  }
}

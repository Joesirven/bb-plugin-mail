// Thin IMAP wrapper used by the poller and the draft command. Read + APPEND
// only — there is no SMTP client and no send/submit call anywhere in this
// module or the rest of the plugin.

import { ImapFlow } from "imapflow";

export interface ImapAccount {
  address: string;
  appPassword: string;
  host?: string;
  port?: number;
  onError?: (message: string) => void;
  // Aborting closes the socket immediately. Without it an in-flight poll
  // outlives plugin dispose — when the app closes mid-poll the connection is
  // left open until the server drops it minutes later, which is precisely when
  // the crashing "Socket timeout" fired.
  signal?: AbortSignal;
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

// ImapFlow attaches richer diagnostics to some errors (authenticationFailed
// for a rejected login, responseText for a tagged NO/BAD) that a bare
// `String(err)` throws away — the exact fields that would tell us apart an
// expired app password from a transient network blip. Never include
// account.appPassword or auth.pass; this only ever touches the error object.
export function describeImapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [`${err.name}: ${err.message}`];
  const withFields = err as Error & { authenticationFailed?: boolean; responseText?: string; code?: string };
  if (withFields.authenticationFailed) parts.push("(authentication failed — check the app password)");
  if (withFields.responseText) parts.push(`server said: ${withFields.responseText}`);
  if (withFields.code) parts.push(`code=${withFields.code}`);
  return parts.join(" ");
}

function client(account: ImapAccount): ImapFlow {
  const c = new ImapFlow({
    host: account.host ?? "imap.gmail.com",
    port: account.port ?? 993,
    secure: true,
    auth: { user: account.address, pass: account.appPassword },
    logger: false,
  });
  // ImapFlow is an EventEmitter, and Node rethrows an 'error' event that has
  // no listener as an uncaught exception — which takes down the whole bb
  // server process, not just this plugin. Socket timeouts are emitted from a
  // timer on a later tick than the awaited call, so neither the try/finally
  // below nor the poller's .catch() in server.ts can ever see them. This
  // listener is the only thing standing between a dropped IMAP socket and a
  // dead server. The pending operation still rejects with the same error, so
  // the caller keeps reporting it; this just stops it from being fatal.
  c.on("error", (err) => {
    account.onError?.(`IMAP client error for ${account.address}: ${describeImapError(err)}`);
  });
  return c;
}

// logout() talks to the server, so it throws when the socket is already gone —
// exactly the case we hit most. Left unguarded in a finally block it replaces
// the real error with a useless one.
async function closeQuietly(c: ImapFlow): Promise<void> {
  try {
    await c.logout();
  } catch {
    c.close();
  }
}

// Single connect/teardown path for every operation in this module. Keeping
// connect() in one place is what lets the abort wiring and the unconditional
// teardown apply to all of them: no caller can open a client and forget either.
async function withClient<T>(account: ImapAccount, run: (c: ImapFlow) => Promise<T>): Promise<T> {
  account.signal?.throwIfAborted();
  const c = client(account);
  const closeOnAbort = () => c.close();
  account.signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await c.connect();
    return await run(c);
  } finally {
    account.signal?.removeEventListener("abort", closeOnAbort);
    await closeQuietly(c);
  }
}

// Pulls messages with UID greater than `sinceUid` from INBOX. Only headers
// and a short preview are fetched here — full bodies are fetched on demand
// elsewhere, never during the routine poll.
export async function pollInbox(account: ImapAccount, sinceUid: number): Promise<FetchedMessage[]> {
  return withClient(account, async (c) => {
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
  });
}

export interface MessageBody {
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  text: string;
}

// Fetches headers + text body for one message, on demand — never called
// during the routine poll, only when a user opens a message's detail view.
export async function fetchMessageBody(account: ImapAccount, uid: number): Promise<MessageBody | null> {
  return withClient(account, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const msg = await c.fetchOne(String(uid), { envelope: true, uid: true, internalDate: true }, { uid: true });
      if (!msg) return null;
      const envelope = msg.envelope;
      const download = await c.download(String(uid), "text", { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) {
        chunks.push(chunk as Buffer);
      }
      return {
        from: envelope?.from?.[0]?.address ?? "unknown",
        to: envelope?.to?.[0]?.address ?? "",
        subject: envelope?.subject ?? "(no subject)",
        receivedAt: new Date(msg.internalDate ?? Date.now()).toISOString(),
        text: Buffer.concat(chunks).toString("utf8"),
      };
    } finally {
      lock.release();
    }
  });
}

// Appends a raw RFC 822 message to the account's Drafts folder — storage
// only, never transmission.
export async function appendDraft(account: ImapAccount, rawMessage: string): Promise<void> {
  await withClient(account, async (c) => {
    await c.append("[Gmail]/Drafts", rawMessage, ["\\Draft"]);
  });
}

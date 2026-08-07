// Builds a raw RFC 822 message for storage as a Gmail draft via IMAP APPEND.
//
// This module only ever produces bytes — it never opens a network
// connection and never transmits anything. There is deliberately no SMTP
// client, no `sendMail`, and no `messages.send` anywhere in this plugin.

export interface DraftFields {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  messageId: string; // caller-supplied so tests are deterministic
  date: string; // caller-supplied RFC 2822 date string
}

function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function foldHeader(name: string, value: string): string {
  return `${name}: ${encodeHeaderValue(value)}`;
}

export function buildRawEmail(fields: DraftFields): string {
  const headers = [
    foldHeader("From", fields.from),
    foldHeader("To", fields.to),
    foldHeader("Subject", fields.subject),
    `Date: ${fields.date}`,
    `Message-ID: ${fields.messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (fields.inReplyTo) headers.push(`In-Reply-To: ${fields.inReplyTo}`);
  if (fields.references) headers.push(`References: ${fields.references}`);

  return `${headers.join("\r\n")}\r\n\r\n${fields.body.replace(/\r?\n/g, "\r\n")}`;
}

export function replySubject(originalSubject: string): string {
  return /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
}

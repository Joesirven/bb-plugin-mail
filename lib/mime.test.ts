import { describe, expect, it } from "vitest";
import { buildRawEmail, replySubject } from "./mime";

describe("buildRawEmail", () => {
  it("produces a well-formed RFC 822 draft with threading headers", () => {
    const raw = buildRawEmail({
      from: "jose@gmail.com",
      to: "boss@acme.com",
      subject: "Re: Quarterly numbers",
      body: "Looks good, thanks.\nJose",
      inReplyTo: "<orig@acme.com>",
      references: "<orig@acme.com>",
      messageId: "<abc@bb-plugin-mail>",
      date: "Fri, 07 Aug 2026 12:00:00 GMT",
    });
    expect(raw).toContain("From: jose@gmail.com\r\n");
    expect(raw).toContain("To: boss@acme.com\r\n");
    expect(raw).toContain("Subject: Re: Quarterly numbers\r\n");
    expect(raw).toContain("In-Reply-To: <orig@acme.com>\r\n");
    expect(raw).toContain("References: <orig@acme.com>\r\n");
    expect(raw).toContain("\r\n\r\nLooks good, thanks.\r\nJose");
  });

  it("MIME-encodes non-ASCII header values", () => {
    const raw = buildRawEmail({
      from: "jose@gmail.com",
      to: "b@acme.com",
      subject: "Café meeting",
      body: "hi",
      messageId: "<x@bb-plugin-mail>",
      date: "Fri, 07 Aug 2026 12:00:00 GMT",
    });
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe("replySubject", () => {
  it("prefixes Re: when missing", () => {
    expect(replySubject("Quarterly numbers")).toBe("Re: Quarterly numbers");
  });

  it("leaves an existing Re: prefix alone", () => {
    expect(replySubject("re: Quarterly numbers")).toBe("re: Quarterly numbers");
  });
});

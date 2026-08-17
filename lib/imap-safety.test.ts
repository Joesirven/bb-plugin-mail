// Regression guard for the incident where an unguarded ImapFlow client's
// unhandled "error" event (e.g. a socket timeout) crashed the whole bb
// server process, not just this plugin. ImapFlow is an EventEmitter — an
// "error" event with zero listeners is an uncaught exception in Node, and
// nothing in an async try/catch around an awaited call can catch it. Every
// construction site must attach an error listener before any I/O happens.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.join(__dirname, "imap.ts"), "utf8");

describe("IMAP client crash safety", () => {
  it("constructs ImapFlow through a single helper", () => {
    const constructions = SOURCE.match(/new\s+ImapFlow\s*\(/g) ?? [];
    expect(constructions.length).toBe(1);
  });

  it("attaches an error listener to every ImapFlow client before it is returned or connected", () => {
    const constructIndex = SOURCE.indexOf("new ImapFlow(");
    expect(constructIndex).toBeGreaterThan(-1);

    const errorListenerIndex = SOURCE.indexOf('.on("error"', constructIndex);
    expect(errorListenerIndex, "no .on(\"error\", ...) found after the ImapFlow construction site").toBeGreaterThan(-1);

    const connectCallIndex = SOURCE.indexOf(".connect()");
    expect(connectCallIndex).toBeGreaterThan(-1);
    expect(errorListenerIndex, "error listener must be attached before connect() is ever called").toBeLessThan(connectCallIndex);
  });

  it("connects through a single helper that closes the client on abort", () => {
    // The crash fired ~2.5 minutes after the app was closed: the poll that was
    // in flight at dispose kept its socket open until the server timed it out.
    // One connect site owning both the abort teardown and the close is what
    // keeps an operation from outliving the plugin instance that started it.
    const connectSites = SOURCE.match(/\.connect\(\)/g) ?? [];
    expect(connectSites.length).toBe(1);

    const helper = SOURCE.slice(SOURCE.indexOf("async function withClient"), SOURCE.indexOf(".connect()"));
    expect(helper, "withClient must close the client when the caller aborts").toMatch(
      /addEventListener\(\s*"abort"/,
    );
  });

  it("the error listener does not itself throw or rethrow", () => {
    const errorListenerIndex = SOURCE.indexOf('.on("error"');
    const snippet = SOURCE.slice(errorListenerIndex, errorListenerIndex + 300);
    expect(snippet).not.toMatch(/throw\s/);
  });
});

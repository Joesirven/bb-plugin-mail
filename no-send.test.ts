// The hard invariant: this plugin NEVER sends email. It only reads over
// IMAP, appends drafts over IMAP, and creates internal bb tasks. This test
// scans the plugin's own source for any code shape that could transmit
// mail, so a future edit that adds one fails CI instead of shipping.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "types"]);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectSourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

// Shapes that indicate an actual send/submit call site, not prose mentioning
// the invariant in a comment.
const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "SMTP transport creation", pattern: /createTransport\s*\(/i },
  { name: "nodemailer sendMail call", pattern: /\bsendMail\s*\(/i },
  { name: "Gmail API messages.send call", pattern: /messages\s*\.\s*send\s*\(/i },
  { name: "nodemailer import", pattern: /from\s+["']nodemailer["']|require\(\s*["']nodemailer["']\s*\)/i },
  { name: "raw SMTP socket usage", pattern: /\bnet\.connect\s*\(\s*.*(465|587)/i },
];

describe("no-send invariant", () => {
  const files = collectSourceFiles(ROOT);

  it("scans more than a trivial number of source files", () => {
    // Guards against the walk silently finding nothing (e.g. a bad ROOT).
    expect(files.length).toBeGreaterThan (3);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f] as const))("%s has no send/submit code path", (_rel, file) => {
    const content = readFileSync(file, "utf8");
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      expect(pattern.test(content), `${file} appears to contain: ${name}`).toBe(false);
    }
  });

  it("declares no SMTP/mail-sending package dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const bannedPackages = ["nodemailer", "smtp-server", "@sendgrid/mail", "mailgun-js", "mailgun.js"];
    for (const banned of bannedPackages) {
      expect(banned in allDeps).toBe(false);
    }
  });

  it("the CLI never registers a send/submit command", () => {
    const server = readFileSync(path.join(ROOT, "server.ts"), "utf8");
    expect(/name:\s*["']send["']/i.test(server)).toBe(false);
    expect(/name:\s*["']mail send["']/i.test(server)).toBe(false);
  });
});

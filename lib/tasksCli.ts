// Shells out to the `bb` CLI to create escalation tasks in the Tasks
// plugin. There is no in-process Tasks SDK surface, so this plugin talks
// to it the same way the official github plugin talks to `gh`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAIL_TASKS_PROJECT_PREFIX = "MAIL";

export interface EscalationTaskInput {
  subject: string;
  from: string;
  account: string;
  snippet: string;
  urgency: "low" | "normal" | "high";
  linkId: string; // internal message id, so a human can trace the task back
}

async function runBb(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bb", args, { maxBuffer: 10 * 1024 * 1024 });
}

export async function ensureMailTasksProject(): Promise<void> {
  try {
    await runBb(["tasks", "project", "show", MAIL_TASKS_PROJECT_PREFIX, "--json"]);
    return;
  } catch {
    // Falls through to create — `show` exits non-zero when the project
    // does not exist yet.
  }
  await runBb([
    "tasks",
    "project",
    "create",
    "--name",
    "Mail",
    "--prefix",
    MAIL_TASKS_PROJECT_PREFIX,
    "--json",
  ]);
}

export async function createEscalationTask(input: EscalationTaskInput): Promise<string | null> {
  await ensureMailTasksProject();
  const description = [
    `Account: ${input.account}`,
    `From: ${input.from}`,
    `Urgency: ${input.urgency}`,
    `Link id: ${input.linkId}`,
    "",
    input.snippet,
  ].join("\n");
  const { stdout } = await runBb([
    "tasks",
    "create",
    "--project",
    MAIL_TASKS_PROJECT_PREFIX,
    "--title",
    input.subject || "(no subject)",
    "--description",
    description,
    "--priority",
    input.urgency === "high" ? "high" : input.urgency === "low" ? "low" : "medium",
    "--label",
    "mail",
    "--json",
  ]);
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.key ?? parsed?.task?.key ?? null;
  } catch {
    return null;
  }
}

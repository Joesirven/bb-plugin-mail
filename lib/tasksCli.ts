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

// The bb server's own process PATH does not necessarily include the bb CLI's
// install directory (it does not go through the interactive shell that set
// up PATH), so a bare "bb" lookup via execFile — which never consults a
// shell or its aliases — can fail with ENOENT even though `bb` works fine
// from a terminal. BB_CLI is the documented env var pointing at the exact
// binary; prefer it and only fall back to a PATH lookup when it is unset.
function bbBinary(): string {
  return process.env.BB_CLI || "bb";
}

async function runBb(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(bbBinary(), args, { maxBuffer: 10 * 1024 * 1024 });
}

const MAIL_TASKS_LABEL = "mail";

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

// Labels are scoped per-project and, unlike the project itself, `tasks
// create --label` does not create a missing one on the fly — it just fails
// the whole task creation with "label not found".
async function ensureMailLabel(): Promise<void> {
  const { stdout } = await runBb(["tasks", "label", "list", "--project", MAIL_TASKS_PROJECT_PREFIX, "--json"]);
  const parsed = JSON.parse(stdout) as { labels?: Array<{ name: string }> };
  if (parsed.labels?.some((label) => label.name === MAIL_TASKS_LABEL)) return;
  await runBb(["tasks", "label", "create", "--project", MAIL_TASKS_PROJECT_PREFIX, "--name", MAIL_TASKS_LABEL, "--json"]);
}

export async function createEscalationTask(input: EscalationTaskInput): Promise<string | null> {
  await ensureMailTasksProject();
  await ensureMailLabel();
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
    MAIL_TASKS_LABEL,
    "--json",
  ]);
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.key ?? parsed?.task?.key ?? null;
  } catch {
    return null;
  }
}

// Pure rule-matching logic. No I/O — kept separate so it is unit-testable
// without a bb server or an IMAP connection.

export type RuleMatchType = "from" | "domain" | "subject-contains" | "list-id";
export type RuleAction = "escalate" | "digest" | "ignore";
export type RuleUrgency = "low" | "normal" | "high";

export interface Rule {
  id: string;
  matchType: RuleMatchType;
  matchValue: string;
  action: RuleAction;
  urgency: RuleUrgency;
  createdAt: string;
}

export interface TriageMessage {
  from: string;
  subject: string;
  listId?: string | null;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? address.toLowerCase() : address.slice(at + 1).toLowerCase();
}

export function matchesRule(message: TriageMessage, rule: Rule): boolean {
  const value = rule.matchValue.trim().toLowerCase();
  if (value === "") return false;
  switch (rule.matchType) {
    case "from":
      return message.from.trim().toLowerCase() === value;
    case "domain":
      return domainOf(message.from) === value.replace(/^@/, "");
    case "subject-contains":
      return message.subject.toLowerCase().includes(value);
    case "list-id":
      return (message.listId ?? "").trim().toLowerCase() === value;
    default:
      return false;
  }
}

export interface TriageResult {
  rule: Rule | null;
  action: RuleAction;
  urgency: RuleUrgency;
}

// Default when no rule matches: surface it in the digest rather than losing
// it silently or escalating unreviewed mail into a task.
const DEFAULT_RESULT: TriageResult = { rule: null, action: "digest", urgency: "normal" };

// Rules are evaluated in the given order; the first match wins. Callers
// control ordering (e.g. by creation order or an explicit priority column).
export function triage(message: TriageMessage, rules: Rule[]): TriageResult {
  for (const rule of rules) {
    if (matchesRule(message, rule)) {
      return { rule, action: rule.action, urgency: rule.urgency };
    }
  }
  return DEFAULT_RESULT;
}

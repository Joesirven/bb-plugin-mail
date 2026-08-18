import * as React from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";

import type { rpcContract } from "./server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Shared types (structural mirrors of the rpc contract's inferred shapes —
// kept local so this file only ever imports server.ts as a type).
// ---------------------------------------------------------------------------

type MatchType = "from" | "domain" | "subject-contains" | "list-id";
type RuleAction = "escalate" | "digest" | "ignore";
type RuleUrgency = "low" | "normal" | "high";
type MessageStatus = "unhandled" | "escalated" | "digested" | "ignored";

interface Rule {
  id: string;
  matchType: MatchType;
  matchValue: string;
  action: RuleAction;
  urgency: RuleUrgency;
  createdAt: string;
}

interface MessageSummary {
  id: string;
  account: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  status: MessageStatus;
  urgency: RuleUrgency;
  ruleId: string | null;
  taskKey: string | null;
}

interface AccountHealth {
  address: string;
  secretName: string;
  configured: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
}

interface DraftSummary {
  id: string;
  messageId: string;
  account: string;
  subject: string;
  bodyPreview: string;
  createdAt: string;
  threadId: string | null;
  originalMessage: { subject: string; from: string; account: string } | null;
}

const MESSAGE_PAGE_SIZE = 50;

const matchTypeOptions: Array<{ value: MatchType; label: string }> = [
  { value: "from", label: "From" },
  { value: "domain", label: "Domain" },
  { value: "subject-contains", label: "Subject contains" },
  { value: "list-id", label: "List id" },
];

const actionOptions: Array<{ value: RuleAction; label: string }> = [
  { value: "escalate", label: "Escalate" },
  { value: "digest", label: "Digest" },
  { value: "ignore", label: "Ignore" },
];

const urgencyOptions: Array<{ value: RuleUrgency; label: string }> = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

const statusFilterOptions: Array<{ value: MessageStatus | "all"; label: string }> = [
  { value: "all", label: "All states" },
  { value: "escalated", label: "Escalated" },
  { value: "digested", label: "Digest" },
  { value: "unhandled", label: "Unhandled" },
  { value: "ignored", label: "Ignored" },
];

function formatTime(value: string | null) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function statusTone(status: MessageStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "escalated") return "default";
  if (status === "ignored") return "secondary";
  if (status === "unhandled") return "outline";
  return "outline";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <label className={className ?? "grid gap-1.5"}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Sub-routing — the panel owns /plugins/mail/mail/*, so sub-navigation lives
// in the route's subPath: "" (inbox), "triage", "drafts", "accounts",
// "inbox/<message-id>" for a message opened in the inbox's reading pane.
// Opening a message is a split-view selection, not a page change — the tab
// bar and message list stay mounted, matching Notion Mail's "side peek"
// (see research notes: side peek / center peek / full page are Notion's own
// three reading-pane modes; side peek — persistent split, list stays visible
// — is the one this mirrors). Still deep-linkable, and browser back/forward
// walks panel-internal history.
// ---------------------------------------------------------------------------

const PANEL_PATH = "mail";

type Route =
  | { view: "inbox"; messageId: string | null }
  | { view: "triage" }
  | { view: "drafts" }
  | { view: "accounts" };

function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((p) => p.length > 0);
  if (parts[0] === "inbox" && parts.length >= 2) {
    return { view: "inbox", messageId: decodeURIComponent(parts.slice(1).join("/")) };
  }
  if (parts[0] === "triage") return { view: "triage" };
  if (parts[0] === "drafts") return { view: "drafts" };
  if (parts[0] === "accounts") return { view: "accounts" };
  return { view: "inbox", messageId: null };
}

function routeToSubPath(route: Route): string {
  switch (route.view) {
    case "inbox":
      return route.messageId ? `inbox/${encodeURIComponent(route.messageId)}` : "";
    case "triage":
      return "triage";
    case "drafts":
      return "drafts";
    case "accounts":
      return "accounts";
  }
}

function useSubPathRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = React.useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = React.useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Data hooks.
// ---------------------------------------------------------------------------

function useAccounts(): { accounts: AccountHealth[] | null; error: string | null; refetch(): void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = React.useState<{ accounts: AccountHealth[] | null; error: string | null }>({
    accounts: null,
    error: null,
  });
  const refetch = React.useCallback(() => {
    rpc.call("listAccounts").then(
      (result) => setState({ accounts: result.accounts, error: null }),
      (error: unknown) => setState({ accounts: null, error: errorText(error) }),
    );
  }, [rpc]);
  React.useEffect(() => refetch(), [refetch]);
  useRealtime("messages-changed", refetch);
  return { ...state, refetch };
}

function useRules(): { rules: Rule[] | null; error: string | null; refetch(): void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = React.useState<{ rules: Rule[] | null; error: string | null }>({
    rules: null,
    error: null,
  });
  const refetch = React.useCallback(() => {
    rpc.call("listRules").then(
      (result) => setState({ rules: result.rules, error: null }),
      (error: unknown) => setState({ rules: null, error: errorText(error) }),
    );
  }, [rpc]);
  React.useEffect(() => refetch(), [refetch]);
  useRealtime("rules-changed", refetch);
  return { ...state, refetch };
}

function useDrafts(): { drafts: DraftSummary[] | null; error: string | null; refetch(): void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = React.useState<{ drafts: DraftSummary[] | null; error: string | null }>({
    drafts: null,
    error: null,
  });
  const refetch = React.useCallback(() => {
    rpc.call("listDrafts").then(
      (result) => setState({ drafts: result.drafts, error: null }),
      (error: unknown) => setState({ drafts: null, error: errorText(error) }),
    );
  }, [rpc]);
  React.useEffect(() => refetch(), [refetch]);
  useRealtime("drafts-changed", refetch);
  return { ...state, refetch };
}

// ---------------------------------------------------------------------------
// Inbox tab — a persistent split view: message list on the left, reading
// pane on the right. Selecting a row never navigates away from the list
// (Notion Mail's "side peek" reading-pane mode); it just updates which
// message the reading pane shows, deep-linked into the subPath so it's still
// bookmarkable and survives a reload.
// ---------------------------------------------------------------------------

function initials(from: string): string {
  const name = from.split("@")[0] ?? from;
  const parts = name.split(/[.\s_-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

function Avatar({ from }: { from: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
    >
      {initials(from)}
    </div>
  );
}

function MessageRow({
  message,
  selected,
  onSelect,
}: {
  message: MessageSummary;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/40 ${
          selected ? "bg-muted" : ""
        }`}
      >
        <Avatar from={message.from} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{message.from}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatTime(message.receivedAt)}</span>
          </div>
          <div className="truncate text-sm text-foreground">{message.subject || "(no subject)"}</div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">{message.snippet}</span>
            <span className="flex shrink-0 items-center gap-1">
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {message.account}
              </Badge>
              <Badge variant={statusTone(message.status)} className="px-1.5 py-0 text-[10px]">
                {message.status}
              </Badge>
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function MessageListPane({
  accounts,
  selectedId,
  onSelect,
}: {
  accounts: AccountHealth[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [account, setAccount] = React.useState("all");
  const [status, setStatus] = React.useState<MessageStatus | "all">("all");
  const [query, setQuery] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [messages, setMessages] = React.useState<MessageSummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const refresh = React.useCallback(
    (nextOffset: number) => {
      const trimmedQuery = query.trim();
      rpc
        .call("listMessages", {
          ...(account === "all" ? {} : { account }),
          ...(status === "all" ? {} : { status }),
          ...(trimmedQuery ? { query: trimmedQuery } : {}),
          offset: nextOffset,
          limit: MESSAGE_PAGE_SIZE,
        })
        .then((result) => {
          setMessages((prev) => (nextOffset === 0 ? result.messages : [...prev, ...result.messages]));
          setTotal(result.total);
          setError(null);
        })
        .catch((err: unknown) => setError(errorText(err)));
    },
    [rpc, account, status, query],
  );

  React.useEffect(() => {
    setOffset(0);
    refresh(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, status, query]);

  useRealtime("messages-changed", () => refresh(0));

  // Notion Mail keyboard nav: j/k or arrow keys move the selection, Escape
  // clears it back to the empty reading-pane state. Ignored while typing in
  // the search box or a select so filter input isn't hijacked.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|select|textarea)$/i.test(target.tagName)) return;
      if (messages.length === 0) return;

      if (event.key === "Escape") {
        onSelect("");
        return;
      }
      const isNext = event.key === "j" || event.key === "ArrowDown";
      const isPrev = event.key === "k" || event.key === "ArrowUp";
      if (!isNext && !isPrev) return;
      event.preventDefault();
      const currentIndex = messages.findIndex((m) => m.id === selectedId);
      const nextIndex = isNext
        ? Math.min(messages.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex === -1 ? 0 : currentIndex - 1);
      const next = messages[nextIndex];
      if (next) onSelect(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [messages, selectedId, onSelect]);

  React.useEffect(() => {
    if (!selectedId || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const accountOptions = [
    { value: "all", label: "All accounts" },
    ...accounts.map((a) => ({ value: a.address, label: a.address })),
  ];

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search mail"
          aria-label="Search"
        />
        <div className="flex gap-2">
          <SelectField label="Account" value={account} options={accountOptions} onChange={setAccount} className="grid flex-1 gap-1" />
          <SelectField<MessageStatus | "all">
            label="Triage state"
            value={status}
            options={statusFilterOptions}
            onChange={setStatus}
            className="grid flex-1 gap-1"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-3 text-sm text-destructive">{error}</p> : null}

        {messages.length === 0 && !error ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No messages match the current filters.</div>
        ) : (
          <ul ref={listRef}>
            {messages.map((message) => (
              <div key={message.id} data-message-id={message.id}>
                <MessageRow message={message} selected={message.id === selectedId} onSelect={() => onSelect(message.id)} />
              </div>
            ))}
          </ul>
        )}

        {messages.length < total ? (
          <div className="p-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                const next = offset + MESSAGE_PAGE_SIZE;
                setOffset(next);
                refresh(next);
              }}
            >
              Load more ({messages.length} of {total})
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReadingPaneEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <Icon name="MailOpen" className="size-8 text-muted-foreground/60" />
      <p>Select a message to read it</p>
    </div>
  );
}

interface MessageDetail {
  id: string;
  account: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  body: string;
  status: MessageStatus;
  urgency: RuleUrgency;
  appliedRule: Rule | null;
}

function ReadingPane({
  id,
  onClose,
  onNavigate,
  hasPrevious,
  hasNext,
}: {
  id: string;
  onClose(): void;
  onNavigate(direction: "previous" | "next"): void;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const bbNavigate = useBbNavigate();
  const [detail, setDetail] = React.useState<MessageDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isDrafting, setIsDrafting] = React.useState(false);

  React.useEffect(() => {
    setDetail(null);
    setError(null);
    rpc.call("getMessageBody", { id }).then(
      (result) => setDetail(result),
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, id]);

  async function draftReply() {
    setIsDrafting(true);
    try {
      const result = await rpc.call("draftReplyThread", { messageId: id, projectId: null });
      toast.success("Reply thread started");
      bbNavigate.toThread(result.threadId);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setIsDrafting(false);
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-2">
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Previous message" disabled={!hasPrevious} onClick={() => onNavigate("previous")}>
            <Icon name="ChevronUp" className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Next message" disabled={!hasNext} onClick={() => onNavigate("next")}>
            <Icon name="ChevronDown" className="size-4" />
          </Button>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close message" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? <div className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">{error}</div> : null}

        {!detail && !error ? <p className="text-sm text-muted-foreground">Loading message…</p> : null}

        {detail ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 gap-3">
                <Avatar from={detail.from} />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-foreground">{detail.subject || "(no subject)"}</h2>
                  <dl className="mt-1 grid gap-0.5 text-sm text-muted-foreground">
                    <div><span className="font-medium text-foreground">From:</span> {detail.from}</div>
                    {detail.to ? <div><span className="font-medium text-foreground">To:</span> {detail.to}</div> : null}
                    <div><span className="font-medium text-foreground">Account:</span> {detail.account}</div>
                    <div><span className="font-medium text-foreground">Received:</span> {formatTime(detail.receivedAt)}</div>
                  </dl>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge variant={statusTone(detail.status)}>{detail.status}</Badge>
                <Button type="button" size="sm" onClick={() => void draftReply()} disabled={isDrafting}>
                  <Icon name="Zap" className="size-4" />
                  {isDrafting ? "Starting…" : "Draft a reply"}
                </Button>
              </div>
            </div>

            {detail.appliedRule ? (
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <span className="font-medium text-foreground">Applied rule:</span>{" "}
                {detail.appliedRule.matchType} = {detail.appliedRule.matchValue} → {detail.appliedRule.action} ({detail.appliedRule.urgency})
              </div>
            ) : (
              <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">No rule matched — default digest handling.</div>
            )}

            <pre className="whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-sm text-foreground">
              {detail.body || "(empty body)"}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InboxSplitView({
  accounts,
  selectedId,
  onSelect,
}: {
  accounts: AccountHealth[];
  selectedId: string | null;
  onSelect(id: string | null): void;
}) {
  // The list pane owns the loaded `messages` array; the split view only
  // needs to know the ordered id sequence for prev/next, so it re-derives
  // that from the same rpc call rather than threading state through props.
  const rpc = useRpc<typeof rpcContract>();
  const [orderedIds, setOrderedIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    rpc.call("listMessages", { offset: 0, limit: MESSAGE_PAGE_SIZE }).then(
      (result) => setOrderedIds(result.messages.map((m) => m.id)),
      () => {},
    );
  }, [rpc]);
  useRealtime("messages-changed", () => {
    rpc.call("listMessages", { offset: 0, limit: MESSAGE_PAGE_SIZE }).then(
      (result) => setOrderedIds(result.messages.map((m) => m.id)),
      () => {},
    );
  });

  const index = selectedId ? orderedIds.indexOf(selectedId) : -1;

  function navigate(direction: "previous" | "next") {
    if (index === -1) return;
    const nextIndex = direction === "previous" ? index - 1 : index + 1;
    const next = orderedIds[nextIndex];
    if (next) onSelect(next);
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border">
      <div className="w-[360px] shrink-0">
        <MessageListPane accounts={accounts} selectedId={selectedId} onSelect={(id) => onSelect(id || null)} />
      </div>
      <div className="min-w-0 flex-1">
        {selectedId ? (
          <ReadingPane
            id={selectedId}
            onClose={() => onSelect(null)}
            onNavigate={navigate}
            hasPrevious={index > 0}
            hasNext={index !== -1 && index < orderedIds.length - 1}
          />
        ) : (
          <ReadingPaneEmptyState />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Triage tab — rule CRUD with a live match-count preview.
// ---------------------------------------------------------------------------

function useMatchPreview(matchType: MatchType, matchValue: string): { matchCount: number; sampleSize: number } | null {
  const rpc = useRpc<typeof rpcContract>();
  const [preview, setPreview] = React.useState<{ matchCount: number; sampleSize: number } | null>(null);

  React.useEffect(() => {
    const trimmed = matchValue.trim();
    if (!trimmed) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("previewRuleMatches", { matchType, matchValue: trimmed }).then(
        (result) => {
          if (!cancelled) setPreview(result);
        },
        () => {
          if (!cancelled) setPreview(null);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, matchType, matchValue]);

  return preview;
}

function RuleForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Rule | null;
  onSaved(): void;
  onCancel?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [matchType, setMatchType] = React.useState<MatchType>(initial?.matchType ?? "domain");
  const [matchValue, setMatchValue] = React.useState(initial?.matchValue ?? "");
  const [action, setAction] = React.useState<RuleAction>(initial?.action ?? "digest");
  const [urgency, setUrgency] = React.useState<RuleUrgency>(initial?.urgency ?? "normal");
  const [error, setError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const preview = useMatchPreview(matchType, matchValue);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = matchValue.trim();
    if (!trimmed) return;
    setIsSaving(true);
    setError(null);
    try {
      if (initial) {
        await rpc.call("updateRule", { id: initial.id, matchType, matchValue: trimmed, action, urgency });
      } else {
        await rpc.call("createRule", { matchType, matchValue: trimmed, action, urgency });
        setMatchValue("");
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="grid gap-2 rounded-md border border-border p-3" onSubmit={save}>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <SelectField<MatchType> label="Match" value={matchType} options={matchTypeOptions} onChange={setMatchType} />
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Value</span>
          <Input value={matchValue} onChange={(event) => setMatchValue(event.currentTarget.value)} placeholder="example.com" />
        </label>
        <SelectField<RuleAction> label="Action" value={action} options={actionOptions} onChange={setAction} />
        <SelectField<RuleUrgency> label="Urgency" value={urgency} options={urgencyOptions} onChange={setUrgency} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {preview
            ? `This rule would have matched ${preview.matchCount} of your last ${preview.sampleSize} messages.`
            : "Enter a value to preview how many recent messages this rule would match."}
        </p>
        <div className="flex gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={!matchValue.trim() || isSaving}>
            {initial ? "Save changes" : "Add rule"}
          </Button>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}

function TriageTab({ rules, onChanged }: { rules: Rule[]; onChanged(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.call("deleteRule", { id });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const editingRule = editingId ? (rules.find((r) => r.id === editingId) ?? null) : null;

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Rules</h2>
        <p className="text-sm text-muted-foreground">
          Rules run in creation order; the first match wins. Unmatched mail is queued for digest.
        </p>
      </div>

      {editingRule ? (
        <RuleForm
          key={editingRule.id}
          initial={editingRule}
          onSaved={() => {
            setEditingId(null);
            onChanged();
          }}
          onCancel={() => setEditingId(null)}
        />
      ) : (
        <RuleForm initial={null} onSaved={onChanged} />
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="rounded-md border border-border">
        {rules.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No rules configured.</div>
        ) : (
          <ul className="divide-y divide-border">
            {rules.map((rule) => (
              <li key={rule.id} className="grid gap-2 p-3 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0">
                  <div className="truncate text-sm text-foreground">
                    <span className="font-medium">{rule.matchType}</span> = {rule.matchValue}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant="outline">{rule.action}</Badge>
                    <Badge variant="secondary">{rule.urgency}</Badge>
                  </div>
                </div>
                <div className="flex gap-1 justify-self-end">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Edit rule ${rule.matchValue}`} onClick={() => setEditingId(rule.id)}>
                    <Icon name="Edit" className="size-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove rule ${rule.matchValue}`} onClick={() => void removeRule(rule.id)}>
                    <Icon name="Trash2" className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drafts tab.
// ---------------------------------------------------------------------------

function DraftsTab({ drafts }: { drafts: DraftSummary[] }) {
  const bbNavigate = useBbNavigate();
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-foreground">
          <span className="font-semibold">bb never sends.</span> Every draft here was saved to the account's own
          Gmail Drafts folder over IMAP. Review and send it from Gmail — this plugin has no send/submit code path.
        </p>
      </div>

      {drafts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          No drafts yet. Open a message in the inbox and use "Draft a reply" to start one.
        </div>
      ) : (
        <ul className="grid gap-2">
          {drafts.map((draft) => (
            <li key={draft.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{draft.subject}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {draft.account} · {formatTime(draft.createdAt)}
                  </div>
                </div>
                {draft.threadId ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => bbNavigate.toThread(draft.threadId!)}>
                    <Icon name="Zap" className="size-4" />
                    Open thread
                  </Button>
                ) : null}
              </div>
              {draft.originalMessage ? (
                <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                  Replying to <span className="text-foreground">{draft.originalMessage.from}</span>:{" "}
                  {draft.originalMessage.subject || "(no subject)"}
                </div>
              ) : null}
              <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{draft.bodyPreview}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts tab.
// ---------------------------------------------------------------------------

function AccountsTab({ accounts }: { accounts: AccountHealth[] }) {
  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Configured accounts</h2>
        <p className="text-sm text-muted-foreground">Connection health for each Gmail account this plugin polls.</p>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          No accounts configured yet.
        </div>
      ) : (
        <ul className="grid gap-2">
          {accounts.map((account) => (
            <li key={account.address} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="flex items-start gap-3">
                <Icon
                  name="ElectricPlugs"
                  className={`mt-0.5 size-4 shrink-0 ${account.configured ? "text-foreground" : "text-muted-foreground"}`}
                />
                <div>
                  <div className="text-sm font-medium text-foreground">{account.address}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Secret: {account.secretName}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Last successful poll: {formatTime(account.lastPolledAt)}</div>
                  {account.lastError ? (
                    <div className="mt-1 flex items-start gap-1 text-xs text-destructive">
                      <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
                      <span className="line-clamp-2">{account.lastError}</span>
                    </div>
                  ) : null}
                </div>
              </div>
              <Badge variant={account.configured ? "outline" : "secondary"}>
                {account.configured ? "configured" : "missing secret"}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-md border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon name="UserRoundPlus" className="size-4" />
          Add another account
        </div>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Generate a Gmail app password for the account (Google Account → Security → 2-Step Verification → App passwords).</li>
          <li>
            Request it as a bb secret (a <code>bb secret request</code>, never typed into chat), then extend the
            <code> accounts</code> plugin setting with the new <code>{"{ address, secretName }"}</code> entry using
            the next free slot (<code>gmailAppPasswordSecondary</code>, <code>…Tertiary</code>, <code>…Quaternary</code>, <code>…Quinary</code>).
          </li>
          <li>
            Run <code>bb plugin reload mail</code>. Secret values are never rendered here — only whether one is set.
          </li>
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel shell.
// ---------------------------------------------------------------------------

function MailPanelHeader() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => window.dispatchEvent(new CustomEvent("mail-panel-refresh"))}
      aria-label="Refresh Mail panel"
    >
      <Icon name="ArrowReloadHorizontal" className="size-4" />
    </Button>
  );
}

function NeedsConfiguration() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center p-6 text-center">
      <div className="rounded-md border border-border bg-card p-5">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md bg-muted">
          <Icon name="Settings" className="size-5 text-muted-foreground" />
        </div>
        <p className="text-base font-medium text-foreground">Mail needs an account before it can triage anything.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Add the <code>accounts</code> setting and its matching Gmail app password secret, then reload the plugin.
          Setup steps are in <code>README.md</code> under "Configure an account", and summarized on the Accounts tab.
        </p>
      </div>
    </div>
  );
}

function MailPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const { accounts, error: accountsError, refetch: refetchAccounts } = useAccounts();
  const { rules, error: rulesError, refetch: refetchRules } = useRules();
  const { drafts, error: draftsError, refetch: refetchDrafts } = useDrafts();

  React.useEffect(() => {
    const listener = () => {
      refetchAccounts();
      refetchRules();
      refetchDrafts();
    };
    window.addEventListener("mail-panel-refresh", listener);
    return () => window.removeEventListener("mail-panel-refresh", listener);
  }, [refetchAccounts, refetchRules, refetchDrafts]);

  const error = accountsError ?? rulesError ?? draftsError;
  if (error) {
    return (
      <div className="p-4 md:p-5">
        <div className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">{error}</div>
      </div>
    );
  }

  if (accounts === null || rules === null || drafts === null) {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-sm text-muted-foreground" role="status">
        Loading mail…
      </div>
    );
  }

  const configuredAccounts = accounts.filter((a) => a.configured);
  if (configuredAccounts.length === 0 && route.view !== "accounts") {
    return <NeedsConfiguration />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl shrink-0">
        <Tabs
          value={route.view}
          onValueChange={(value) => {
            if (value === "inbox") navigate({ view: "inbox", messageId: null });
            else if (value === "triage" || value === "drafts" || value === "accounts") navigate({ view: value });
          }}
        >
          <TabsList>
            <TabsTrigger value="inbox">Inbox</TabsTrigger>
            <TabsTrigger value="triage">Triage</TabsTrigger>
            <TabsTrigger value="drafts">Drafts</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
        {route.view === "inbox" ? (
          <InboxSplitView
            accounts={configuredAccounts}
            selectedId={route.messageId}
            onSelect={(id) => navigate({ view: "inbox", messageId: id })}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {route.view === "triage" ? <TriageTab rules={rules} onChanged={refetchRules} /> : null}
            {route.view === "drafts" ? <DraftsTab drafts={drafts} /> : null}
            {route.view === "accounts" ? <AccountsTab accounts={accounts} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    title: "Mail",
    icon: "Mail",
    path: "mail",
    component: MailPanel,
    headerContent: MailPanelHeader,
  });
});

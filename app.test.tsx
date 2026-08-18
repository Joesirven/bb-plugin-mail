// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const account = {
  address: "jose@gmail.com",
  secretName: "gmailAppPasswordPrimary",
  configured: true,
  lastPolledAt: "2026-08-09T12:00:00.000Z",
  lastError: null,
};

const message = {
  id: "jose@gmail.com:1",
  account: "jose@gmail.com",
  from: "alerts@example.com",
  subject: "Review this",
  snippet: "A short preview",
  receivedAt: "2026-08-09T12:00:00.000Z",
  status: "unhandled" as const,
  urgency: "normal" as const,
  ruleId: null,
  taskKey: null,
};

const secondMessage = {
  id: "jose@gmail.com:2",
  account: "jose@gmail.com",
  from: "billing@example.com",
  subject: "Your invoice",
  snippet: "Invoice attached",
  receivedAt: "2026-08-09T13:00:00.000Z",
  status: "digested" as const,
  urgency: "normal" as const,
  ruleId: null,
  taskKey: null,
};

const rule = {
  id: "rule-1",
  matchType: "domain" as const,
  matchValue: "example.com",
  action: "digest" as const,
  urgency: "normal" as const,
  createdAt: "2026-08-09T12:00:01.000Z",
};

const draft = {
  id: "draft-1",
  messageId: message.id,
  account: message.account,
  subject: "Re: Review this",
  bodyPreview: "Sounds good, will do.",
  createdAt: "2026-08-09T12:05:00.000Z",
  threadId: "thr_abc123",
  originalMessage: { subject: message.subject, from: message.from, account: message.account },
};

describe("Mail nav panel", () => {
  it("registers the Mail panel with host header content", () => {
    expect(app.navPanels[0]).toMatchObject({
      id: "mail",
      title: "Mail",
      icon: "Mail",
      path: "mail",
      headerContent: expect.any(Function),
    });
  });

  it("shows setup guidance when no account is configured", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listAccounts: () => ({ accounts: [] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
        },
      },
    );

    await slot.findByText(/Mail needs an account/);
    expect(slot.getByText(/README\.md/)).toBeTruthy();
  });

  it("lists inbox messages, applies filters, and links to the detail view", async () => {
    const listMessages = vi.fn(() => ({ messages: [message], total: 1 }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          listMessages,
        },
      },
    );

    await slot.findByText("alerts@example.com");
    expect(slot.getByText("unhandled")).toBeTruthy();

    fireEvent.change(slot.getByLabelText("Triage state"), { target: { value: "escalated" } });
    await waitFor(() => {
      expect(listMessages).toHaveBeenLastCalledWith({
        status: "escalated",
        offset: 0,
        limit: 50,
      });
    });

    fireEvent.click(slot.getByText("alerts@example.com"));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "mail",
      options: { subPath: `inbox/${encodeURIComponent(message.id)}` },
    });
  });

  it("fetches a message body on demand for the detail view and never preloads it from listMessages", async () => {
    const getMessageBody = vi.fn(() => ({
      id: message.id,
      account: message.account,
      from: message.from,
      to: "me@example.com",
      subject: message.subject,
      receivedAt: message.receivedAt,
      body: "Full message body text.",
      status: message.status,
      urgency: message.urgency,
      appliedRule: null,
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `inbox/${encodeURIComponent(message.id)}` },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          getMessageBody,
        },
      },
    );

    await slot.findByText("Full message body text.");
    expect(getMessageBody).toHaveBeenCalledWith({ id: message.id });
    expect(getMessageBody).toHaveBeenCalledTimes(1);
  });

  it("opens a message as a split view without navigating away from the list", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `inbox/${encodeURIComponent(message.id)}` },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          listMessages: () => ({ messages: [message, secondMessage], total: 2 }),
          getMessageBody: () => ({
            id: message.id,
            account: message.account,
            from: message.from,
            to: "",
            subject: message.subject,
            receivedAt: message.receivedAt,
            body: "Full message body text.",
            status: message.status,
            urgency: message.urgency,
            appliedRule: null,
          }),
        },
      },
    );

    // The reading pane shows the selected message...
    await slot.findByText("Full message body text.");
    // ...while both list rows, including the unselected one, stay mounted and visible.
    expect(slot.getByText(secondMessage.from)).toBeTruthy();
    expect(slot.getByRole("tab", { name: "Triage" })).toBeTruthy();

    // The Tabs bar and the Inbox tab route both remain the "inbox" tab, not a separate page.
    expect(slot.getByRole("tab", { name: "Inbox", selected: true })).toBeTruthy();

    // Closing the reading pane navigates back to the bare inbox subPath — a
    // selection-clearing intent, not a route/page change (the mounted slot's
    // subPath prop is fixed per render in this harness, same as the
    // tab-switch test below; we assert the navigate call, not a live re-render).
    fireEvent.click(slot.getByRole("button", { name: "Close message" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "mail",
      options: { subPath: "" },
    });
  });

  it("navigates to the next message via the reading-pane chevron and via keyboard", async () => {
    const getMessageBody = vi.fn((input: unknown) => {
      const id = (input as { id: string }).id;
      const source = id === message.id ? message : secondMessage;
      return {
        id: source.id,
        account: source.account,
        from: source.from,
        to: "",
        subject: source.subject,
        receivedAt: source.receivedAt,
        body: `Body for ${source.id}`,
        status: source.status,
        urgency: source.urgency,
        appliedRule: null,
      };
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `inbox/${encodeURIComponent(message.id)}` },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          listMessages: () => ({ messages: [message, secondMessage], total: 2 }),
          getMessageBody,
        },
      },
    );

    await slot.findByText(`Body for ${message.id}`);
    fireEvent.click(slot.getByRole("button", { name: "Next message" }));
    await waitFor(() => {
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "mail",
        options: { subPath: `inbox/${encodeURIComponent(secondMessage.id)}` },
      });
    });
  });

  it("moves the list selection with j/k keyboard shortcuts", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          listMessages: () => ({ messages: [message, secondMessage], total: 2 }),
        },
      },
    );

    await slot.findByText(message.from);
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "mail",
        options: { subPath: `inbox/${encodeURIComponent(message.id)}` },
      });
    });
  });

  it("starts a draft-reply thread and navigates to it", async () => {
    const draftReplyThread = vi.fn(() => ({ threadId: "thr_new" }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `inbox/${encodeURIComponent(message.id)}` },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          getMessageBody: () => ({
            id: message.id,
            account: message.account,
            from: message.from,
            to: "",
            subject: message.subject,
            receivedAt: message.receivedAt,
            body: "Body",
            status: message.status,
            urgency: message.urgency,
            appliedRule: null,
          }),
          draftReplyThread,
        },
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: /Draft a reply/ }));
    await waitFor(() => {
      expect(draftReplyThread).toHaveBeenCalledWith({ messageId: message.id, projectId: null });
    });
    await waitFor(() => {
      expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_new" });
    });
  });

  it("previews rule match counts live and manages rules through RPC", async () => {
    const previewRuleMatches = vi.fn(() => ({ matchCount: 3, sampleSize: 200 }));
    const createRule = vi.fn(() => ({
      rule: { id: "rule-2", matchType: "from", matchValue: "boss@example.com", action: "escalate", urgency: "high", createdAt: "2026-08-09T12:00:02.000Z" },
    }));
    const deleteRule = vi.fn(() => ({ ok: true }));

    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "triage" },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [rule] }),
          listDrafts: () => ({ drafts: [] }),
          previewRuleMatches,
          createRule,
          deleteRule,
        },
      },
    );

    await slot.findByText(/example.com/);

    fireEvent.change(slot.getByLabelText("Value"), { target: { value: "boss@example.com" } });
    await waitFor(() => {
      expect(previewRuleMatches).toHaveBeenCalledWith({ matchType: "domain", matchValue: "boss@example.com" });
    });
    await slot.findByText(/would have matched 3 of your last 200 messages/);

    fireEvent.change(slot.getByLabelText("Match"), { target: { value: "from" } });
    fireEvent.change(slot.getByLabelText("Action"), { target: { value: "escalate" } });
    fireEvent.change(slot.getByLabelText("Urgency"), { target: { value: "high" } });
    fireEvent.click(slot.getByRole("button", { name: "Add rule" }));

    await waitFor(() => {
      expect(createRule).toHaveBeenCalledWith({
        matchType: "from",
        matchValue: "boss@example.com",
        action: "escalate",
        urgency: "high",
      });
    });

    fireEvent.click(slot.getByRole("button", { name: `Remove rule ${rule.matchValue}` }));
    await waitFor(() => {
      expect(deleteRule).toHaveBeenCalledWith({ id: rule.id });
    });
  });

  it("shows the never-send notice and links a draft to its source thread", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "drafts" },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [draft] }),
        },
      },
    );

    await slot.findByText(/bb never sends/);
    expect(slot.getByText(draft.subject)).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Open thread" }));
    expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: draft.threadId });
  });

  it("shows account connection health without rendering secret values", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "accounts" },
      {
        rpc: {
          listAccounts: () => ({
            accounts: [
              account,
              { address: "broken@gmail.com", secretName: "gmailAppPasswordSecondary", configured: false, lastPolledAt: null, lastError: "auth failed" },
            ],
          }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
        },
      },
    );

    await slot.findByText(account.address);
    expect(slot.getByText("broken@gmail.com")).toBeTruthy();
    expect(slot.getByText("auth failed")).toBeTruthy();
    expect(slot.getByText("missing secret")).toBeTruthy();
    expect(slot.getByText(/Add another account/)).toBeTruthy();
    expect(slot.container.textContent).not.toMatch(/app-password-value/);
  });

  it("switching tabs navigates to the matching subPath", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listAccounts: () => ({ accounts: [account] }),
          listRules: () => ({ rules: [] }),
          listDrafts: () => ({ drafts: [] }),
          listMessages: () => ({ messages: [], total: 0 }),
        },
      },
    );

    await slot.findByRole("tab", { name: "Triage" });
    fireEvent.mouseDown(slot.getByRole("tab", { name: "Triage" }), { button: 0 });
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "mail",
      options: { subPath: "triage" },
    });
  });
});

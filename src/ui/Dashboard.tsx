import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { createAccountsApi } from "./accountsApi.js";
import type { AccountsApi } from "./accountsApi.js";
import { createModelsApi } from "./modelsApi.js";
import type { ModelsApi, ModelsStatus } from "./modelsApi.js";
import { buildFrame } from "./status-frame.js";
import type { Banner } from "./status-frame.js";
import { planLayout } from "./status-layout.js";
import type { Focus, HealthData, Mode } from "./status-types.js";
import type { Seg } from "./term-text.js";

// Re-exported so existing imports (and their tests) keep working: these moved
// to modules that have no terminal in them.
export { terminalSafeText } from "./term-text.js";
export { usageDetailMode, getVisibleModelWindow } from "./status-frame.js";
export type { UsageDetailMode } from "./status-frame.js";

const POLL_INTERVAL_MS = 2_000;

// ─── Dashboard component ──────────────────────────────────────────────────────

export interface DashboardProps {
  port: number;
  baseUrl?: string;
  authToken?: string;
  /** Callback fired when the dashboard wants the outer shell to perform an
   *  action that can't run while Ink is rendering (e.g. OAuth flow). */
  onIntent?: (intent: "quit" | "addAccount") => void;
}

export function Dashboard({ port, baseUrl, authToken, onIntent }: DashboardProps) {
  const { exit } = useApp();
  const [data, setData] = useState<HealthData | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [retryCount, setRetryCount] = useState(0);

  const resolvedBase = baseUrl
    ? baseUrl.replace(/\/+$/, "")
    : `http://localhost:${port}`;

  const api = React.useMemo(
    () => createAccountsApi(resolvedBase, authToken),
    [resolvedBase, authToken],
  );
  const modelsApi = React.useMemo(
    () => createModelsApi(resolvedBase, authToken),
    [resolvedBase, authToken],
  );

  // Only q to quit when no live data yet (no mode to cancel)
  useInput((input, key) => {
    if (!data && (input === "q" || key.escape)) exit();
  });

  useEffect(() => {
    let cancelled = false;

    const healthUrl = `${resolvedBase}/cc-router/health`;
    const headers: Record<string, string> = authToken
      ? { authorization: `Bearer ${authToken}` }
      : {};

    const poll = async () => {
      try {
        const res = await fetch(healthUrl, {
          headers,
          signal: AbortSignal.timeout(1_500),
        });
        if (cancelled) return;
        if (res.ok) {
          setData(await res.json() as HealthData);
          setConnectError(null);
          setLastUpdate(Date.now());
          setRetryCount(0);
        } else {
          setConnectError(`Proxy returned HTTP ${res.status}`);
        }
      } catch {
        if (cancelled) return;
        setConnectError(`Cannot connect to ${resolvedBase}`);
        setRetryCount(n => n + 1);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [resolvedBase, authToken]);

  if (connectError) {
    return <ErrorScreen error={connectError} port={port} retries={retryCount} />;
  }

  if (!data) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">⠋ Connecting to {resolvedBase}...</Text>
      </Box>
    );
  }

  return (
    <LiveDashboard
      data={data}
      port={port}
      baseUrl={resolvedBase}
      lastUpdate={lastUpdate}
      api={api}
      modelsApi={modelsApi}
      onIntent={onIntent}
    />
  );
}

// ─── Error screen ─────────────────────────────────────────────────────────────

function ErrorScreen({ error, port, retries }: { error: string; port: number; retries: number }) {
  return (
    <Box flexDirection="column" marginY={1} marginX={2}>
      <Text color="red" bold>✗ {error}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Is the proxy running? Start it with:</Text>
        <Text color="cyan">  cc-router start</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Retrying every {POLL_INTERVAL_MS / 1000}s</Text>
        {retries > 0 && <Text color="gray">  (attempt {retries})</Text>}
        <Text color="gray">  ·  [q] quit</Text>
      </Box>
    </Box>
  );
}

// ─── Live dashboard ───────────────────────────────────────────────────────────

function LiveDashboard({
  data, port, baseUrl, lastUpdate, api, modelsApi, onIntent,
}: {
  data: HealthData; port: number; baseUrl: string; lastUpdate: number;
  api: AccountsApi; modelsApi: ModelsApi; onIntent?: (intent: "quit" | "addAccount") => void;
}) {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const updatedAgo = Math.round((Date.now() - lastUpdate) / 1000);
  const logs = data.recentLogs;
  // Details are opened on purpose (Enter) rather than always shown: in a small
  // pane they cost the log its rows, and the frame decides whether there is room.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // ── Focus / mode ──────────────────────────────────────────────────────────
  const [focus, setFocus] = useState<Focus>("logs");
  const [mode, setMode] = useState<Mode>("view");

  // Selected log by timestamp (existing)
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  // How many log rows this pane can show decides how far ↑↓ may go: a cursor on a
  // row that is not drawn would be a selection nobody can see.
  const layout = planLayout({
    rows, cols, accountCount: data.accounts.length,
    region: focus === "models" ? "models" : "activity", detailsOpen,
  });
  const visibleLogCount = Math.max(1, Math.min(logs.length, layout.regionBody));
  const selectedLogIndex = Math.min(
    visibleLogCount - 1,
    selectedTs !== null ? Math.max(0, logs.findIndex(l => l.ts === selectedTs)) : 0,
  );

  // Selected account by id
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const selectedAccountIndex = selectedAccountId !== null
    ? Math.max(0, data.accounts.findIndex(a => a.id === selectedAccountId))
    : 0;
  const selectedAccount = data.accounts[selectedAccountIndex] ?? null;
  const selectedAccountIsAnthropic = selectedAccount?.provider !== "openai_subscription";

  const [modelsStatus, setModelsStatus] = useState<ModelsStatus | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const modelRows = modelsStatus?.models ?? [];
  const selectedModelIndex = selectedModelId !== null
    ? Math.max(0, modelRows.findIndex(m => m.id === selectedModelId))
    : 0;
  const selectedModel = modelRows[selectedModelIndex] ?? null;

  // Inline text input state (for w / s keys)
  const [editBuffer, setEditBuffer] = useState("");

  // Transient banner (error or success, cleared after 4s).
  // The timer handle is stored in a ref so new banners cancel the previous
  // timeout and component unmount also clears it — otherwise a deferred
  // setBanner can fire on an unmounted component after `n` exits Ink.
  const [banner, setBanner] = useState<Banner | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback((text: string, color: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ text, color });
    bannerTimerRef.current = setTimeout(() => {
      setBanner(null);
      bannerTimerRef.current = null;
    }, 4_000);
  }, []);
  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  // Normalize any thrown value to a displayable string — rejections from
  // fetch/AbortSignal can be DOMException without .message, strings, or
  // even undefined.
  const errMsg = (err: unknown): string => {
    if (err instanceof Error && err.message) return err.message;
    const s = String(err ?? "");
    return s || "unknown error";
  };

  // ── Async helpers (fire-and-forget with error → banner) ──────────────────
  const doToggleEnabled = useCallback(async () => {
    if (!selectedAccount) return;
    if (selectedAccount.provider === "openai_subscription") {
      showBanner("OpenAI accounts are managed from the CLI", "yellow");
      return;
    }
    const newValue = !(selectedAccount.enabled !== false);
    try {
      await api.patch(selectedAccount.id, { enabled: newValue });
      showBanner(`${selectedAccount.id} → ${newValue ? "enabled" : "disabled"}`, newValue ? "green" : "yellow");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doToggleProvider = useCallback(async (provider: "anthropic_subscription" | "openai_subscription") => {
    const providerStatus = provider === "anthropic_subscription"
      ? data.operational?.providers.anthropic
      : data.operational?.providers.openai;
    const label = provider === "anthropic_subscription" ? "Claude" : "OpenAI";
    if (!providerStatus?.configured || providerStatus.accounts === 0) {
      showBanner(`${label} accounts are not configured`, "yellow");
      return;
    }

    const enabled = providerStatus.enabled < providerStatus.accounts;
    try {
      await api.setProviderEnabled(provider, enabled);
      showBanner(`${label} accounts → ${enabled ? "enabled" : "disabled"}`, enabled ? "green" : "yellow");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [api, data.operational, showBanner]);

  const doSetLimit = useCallback(async (field: "sessionLimitPercent" | "weeklyLimitPercent", value: number) => {
    if (!selectedAccount) return;
    if (selectedAccount.provider === "openai_subscription") {
      showBanner("OpenAI accounts do not use Anthropic caps", "yellow");
      return;
    }
    try {
      await api.patch(selectedAccount.id, { [field]: value });
      const label = field === "sessionLimitPercent" ? "5h cap" : "7d cap";
      showBanner(`${selectedAccount.id} → ${label} = ${value}%`, "green");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doDelete = useCallback(async () => {
    if (!selectedAccount) return;
    if (selectedAccount.provider === "openai_subscription") {
      showBanner("Use cc-router accounts remove for OpenAI accounts", "yellow");
      return;
    }
    try {
      await api.remove(selectedAccount.id);
      showBanner(`Removed ${selectedAccount.id}`, "yellow");
      setSelectedAccountId(null);
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doLoadModels = useCallback(async () => {
    try {
      const status = await modelsApi.list();
      setModelsStatus(status);
      setSelectedModelId(status.models[0]?.id ?? null);
      setFocus("models");
      showBanner(`Loaded ${status.models.length} models`, "green");
    } catch (err) {
      showBanner(`Models error: ${errMsg(err)}`, "red");
    }
  }, [modelsApi, showBanner]);

  const doSetSelectedModel = useCallback(async (provider: "claude" | "openai") => {
    if (!selectedModel) return;
    if (provider === "claude" && !selectedModel.id.startsWith("anthropic/")) {
      showBanner("Select an anthropic/* model for Claude", "yellow");
      return;
    }
    if (provider === "openai" && !selectedModel.id.startsWith("openai/")) {
      showBanner("Select an openai/* model for OpenAI", "yellow");
      return;
    }

    try {
      const status = await modelsApi.setDefaults(
        provider === "claude"
          ? { claudeModel: selectedModel.id }
          : { openAIModel: selectedModel.id },
      );
      setModelsStatus(previous => ({
        routing: status.routing,
        models: status.models.length > 0 ? status.models : previous?.models ?? [],
      }));
      showBanner(`${provider === "claude" ? "Claude" : "OpenAI"} default → ${selectedModel.id}`, "green");
    } catch (err) {
      showBanner(`Models error: ${errMsg(err)}`, "red");
    }
  }, [modelsApi, selectedModel, showBanner]);

  // ── Keyboard handler ──────────────────────────────────────────────────────
  useInput((input, key) => {
    // ── Text editing mode (w / s) ───────────────────────────────────────
    if (mode === "editSession" || mode === "editWeekly") {
      if (key.escape) {
        setMode("view");
        setEditBuffer("");
        return;
      }
      if (key.return) {
        const parsed = parseInt(editBuffer, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          const field = mode === "editSession" ? "sessionLimitPercent" as const : "weeklyLimitPercent" as const;
          void doSetLimit(field, parsed);
        } else {
          showBanner("Invalid: enter a number 0–100", "red");
        }
        setMode("view");
        setEditBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer(b => b.slice(0, -1));
        return;
      }
      if (/^[0-9]$/.test(input) && editBuffer.length < 3) {
        setEditBuffer(b => b + input);
      }
      return;
    }

    // ── Confirm delete (y/n) ────────────────────────────────────────────
    if (mode === "confirmDelete") {
      if (input === "y" || input === "Y") {
        void doDelete();
        setMode("view");
      } else {
        setMode("view");
        showBanner("Delete cancelled", "gray");
      }
      return;
    }

    // ── Normal view mode ────────────────────────────────────────────────
    // Always call exit() so Ink fully unmounts and releases stdin.
    // The outer dashboardLoop reads `pendingIntent` after waitUntilExit().
    if (input === "q") { onIntent?.("quit"); exit(); return; }
    if (key.escape) {
      if (detailsOpen) { setDetailsOpen(false); return; }
      if (focus === "accounts" || focus === "models") { setFocus("logs"); return; }
      onIntent?.("quit"); exit();
      return;
    }

    if (key.tab) {
      setFocus(f => f === "logs" ? "accounts" : f === "accounts" ? "models" : "logs");
      return;
    }

    // Navigation: ↑↓ move within the focused panel
    if (focus === "logs") {
      if (key.return) { setDetailsOpen(open => !open); return; }
      if (key.upArrow) {
        const next = Math.max(0, selectedLogIndex - 1);
        setSelectedTs(logs[next]?.ts ?? null);
      }
      if (key.downArrow) {
        const next = Math.min(visibleLogCount - 1, selectedLogIndex + 1);
        setSelectedTs(logs[next]?.ts ?? null);
      }
    }

    if (focus === "accounts") {
      if (key.upArrow) {
        const next = Math.max(0, selectedAccountIndex - 1);
        setSelectedAccountId(data.accounts[next]?.id ?? null);
      }
      if (key.downArrow) {
        const next = Math.min(data.accounts.length - 1, selectedAccountIndex + 1);
        setSelectedAccountId(data.accounts[next]?.id ?? null);
      }

      // Account actions (only when focus = accounts)
      if (input === "e") { void doToggleEnabled(); return; }
      if (input === "a") { void doToggleProvider("anthropic_subscription"); return; }
      if (input === "o") { void doToggleProvider("openai_subscription"); return; }
      if (input === "w") {
        if (!selectedAccountIsAnthropic) { showBanner("OpenAI accounts do not use Anthropic caps", "yellow"); return; }
        setMode("editWeekly"); setEditBuffer(""); return;
      }
      if (input === "s") {
        if (!selectedAccountIsAnthropic) { showBanner("OpenAI accounts do not use Anthropic caps", "yellow"); return; }
        setMode("editSession"); setEditBuffer(""); return;
      }
      if (input === "d") {
        if (!selectedAccountIsAnthropic) { showBanner("Use cc-router accounts remove for OpenAI accounts", "yellow"); return; }
        setMode("confirmDelete"); return;
      }
    }

    if (focus === "models") {
      if (key.upArrow) {
        const next = Math.max(0, selectedModelIndex - 1);
        setSelectedModelId(modelRows[next]?.id ?? null);
      }
      if (key.downArrow) {
        const next = Math.min(modelRows.length - 1, selectedModelIndex + 1);
        setSelectedModelId(modelRows[next]?.id ?? null);
      }
      if (input === "r") { void doLoadModels(); return; }
      if (input === "c") { void doSetSelectedModel("claude"); return; }
      if (input === "o") { void doSetSelectedModel("openai"); return; }
    }

    if (input === "m") {
      void doLoadModels();
      return;
    }

    // n = add account — works regardless of focus.
    // Requires an onIntent handler because the outer loop runs the OAuth
    // flow after Ink unmounts; if none is wired, this key is a no-op.
    if (input === "n") {
      if (onIntent) { onIntent("addAccount"); exit(); }
      return;
    }
  });

  const { lines } = buildFrame({
    data,
    severity: data.severity,
    now: Date.now(),
    cols,
    rows,
    baseUrl,
    updatedAgoSec: updatedAgo,
    focus,
    mode,
    editBuffer,
    selectedLogIndex,
    selectedAccountIndex,
    detailsOpen,
    modelsStatus,
    selectedModelIndex,
    banner,
  });

  return <FrameView lines={lines} />;
}

/**
 * Draws the frame. Each line is already as wide as the pane allows, so it is
 * handed to Ink as one `Text` that is told not to wrap; Ink then cannot turn a
 * line into two and push the frame past the terminal's height.
 */
function FrameView({ lines }: { lines: Seg[][] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line.length === 0
            ? " "
            : line.map((s, j) => (
                <Text key={j} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}

/**
 * The size of the pane the dashboard is drawn into, kept current as it is
 * resized. A pipe has no size, so it gets a generous one.
 */
function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({ cols: stdout?.columns || 100, rows: stdout?.rows || 40 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return size;
}

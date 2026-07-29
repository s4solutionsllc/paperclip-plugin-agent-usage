// Pure parsing & formatting helpers, extracted from worker.ts so they can be
// unit-tested without spinning up the plugin runtime.

export interface QuotaWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail: string | null;
}

export interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

export interface AnthropicExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

export interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
}

export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null || !Number.isFinite(utilization)) return null;
  return Math.max(0, Math.min(100, Math.round(utilization * 100)));
}

export function formatCurrency(value: number, currency: string | null | undefined): string {
  const code =
    typeof currency === "string" && currency.trim().length > 0
      ? currency.trim().toUpperCase()
      : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

export function parseAnthropicResponse(body: AnthropicUsageResponse): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  if (body.five_hour != null) {
    windows.push({
      label: "Current session (5h)",
      usedPercent: toPercent(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day != null) {
    windows.push({
      label: "Week — all models",
      usedPercent: toPercent(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_sonnet != null) {
    windows.push({
      label: "Week — Sonnet",
      usedPercent: toPercent(body.seven_day_sonnet.utilization),
      resetsAt: body.seven_day_sonnet.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_opus != null) {
    windows.push({
      label: "Week — Opus",
      usedPercent: toPercent(body.seven_day_opus.utilization),
      resetsAt: body.seven_day_opus.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.extra_usage != null) {
    const eu = body.extra_usage;
    let valueLabel: string | null = null;
    if (
      eu.is_enabled !== false &&
      typeof eu.monthly_limit === "number" &&
      typeof eu.used_credits === "number"
    ) {
      valueLabel = `${formatCurrency(eu.used_credits / 100, eu.currency)} / ${formatCurrency(eu.monthly_limit / 100, eu.currency)}`;
    }
    windows.push({
      label: "Extra usage",
      usedPercent: eu.is_enabled === false ? null : toPercent(eu.utilization),
      resetsAt: null,
      valueLabel: eu.is_enabled === false ? "Not enabled" : valueLabel,
      detail: eu.is_enabled === false ? "Extra usage not enabled" : "Monthly extra usage pool",
    });
  }

  return windows;
}

// Extracts the signed-in account email from Claude Code's main config
// (`.claude.json`), whose `oauthAccount.emailAddress` identifies the account.
export function extractAccountEmail(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const account = (parsed as Record<string, unknown>)["oauthAccount"];
  if (typeof account !== "object" || account === null) return null;
  const email = (account as Record<string, unknown>)["emailAddress"];
  if (typeof email === "string" && email.trim().length > 0) return email.trim();
  return null;
}

export function stripBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") {
      out = out.slice(0, -1);
    } else {
      out += char;
    }
  }
  return out;
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g, "");
}

export function cleanTerminalText(text: string): string {
  return stripAnsi(stripBackspaces(text)).replace(/\r/g, "\n");
}

export function normalizeForLabelSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lower.lastIndexOf("settings:");
  if (settingsIndex < 0) return null;
  const tail = text.slice(settingsIndex);
  const tailLower = tail.toLowerCase();
  if (!tailLower.includes("usage")) return null;
  if (!tailLower.includes("current session") && !tailLower.includes("loading usage")) return null;
  return tail;
}

export function isQuotaLabel(line: string): boolean {
  const n = normalizeForLabelSearch(line);
  return n === "currentsession"
    || n === "currentweekallmodels"
    || n === "currentweeksonnetonly"
    || n === "currentweeksonnet"
    || n === "currentweekopusonly"
    || n === "currentweekopus"
    || n === "extrausage";
}

export function canonicalQuotaLabel(line: string): string {
  switch (normalizeForLabelSearch(line)) {
    case "currentsession": return "Current session (5h)";
    case "currentweekallmodels": return "Week — all models";
    case "currentweeksonnetonly":
    case "currentweeksonnet": return "Week — Sonnet";
    case "currentweekopusonly":
    case "currentweekopus": return "Week — Opus";
    case "extrausage": return "Extra usage";
    default: return line;
  }
}

export function percentFromLine(line: string): number | null {
  const match = line.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const rawValue = Number(match[1]);
  if (!Number.isFinite(rawValue)) return null;
  const clamped = Math.min(100, Math.max(0, rawValue));
  const lower = line.toLowerCase();
  if (lower.includes("remaining") || lower.includes("left") || lower.includes("available")) {
    return Math.max(0, Math.min(100, Math.round(100 - clamped)));
  }
  return Math.round(clamped);
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const lines = cleaned.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const windows = sections.map<QuotaWindow>((section) => {
    const usedPercent = section.lines.map(percentFromLine).find((v) => v != null) ?? null;
    return {
      label: section.label,
      usedPercent,
      resetsAt: null,
      valueLabel: null,
      detail: null,
    };
  });

  if (!windows.some((w) => normalizeForLabelSearch(w.label).includes("session"))) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return windows;
}

// The CLI fallback drives Claude Code's interactive TUI on a fixed timer. When
// the account running the Paperclip worker has never completed Claude Code's
// first-run flow, that TUI is an onboarding wizard rather than a session, so
// `/usage` is typed into a theme picker and the process never exits. Detecting
// those screens lets us fail fast with an actionable message instead of
// burning the full timeout and reporting a raw shell error.
interface CliBlocker {
  pattern: RegExp;
  message: string;
}

// Patterns are matched against `normalizeForLabelSearch` output, so they carry
// no spaces or punctuation: Claude Code's TUI lays words out with cursor-column
// escapes (`\x1b[9G`) instead of literal spaces, so once ANSI is stripped the
// captured text reads "WelcometoClaudeCode".
const CLI_BLOCKERS: CliBlocker[] = [
  {
    pattern: /choosethetextstyle|letsgetstarted|welcometoclaudecode/,
    message:
      "Claude Code onboarding has not been completed for the user running Paperclip. Run `claude` once as that user and finish the first-run setup.",
  },
  {
    pattern: /doyoutrustthefiles|yesproceed/,
    message:
      "Claude Code is waiting on its folder-trust prompt. Run `claude` once in this directory as the user running Paperclip and approve it.",
  },
  {
    pattern: /pleaserunlogin|signintoclaude|invalidapikey|authenticationerror/,
    message:
      "Claude Code is not signed in for the user running Paperclip. Run `claude` and sign in, or configure an OAuth token.",
  },
];

// Returns an actionable message when the captured terminal output shows Claude
// Code stuck on an interactive prompt, or null when nothing blocking is found.
export function detectCliBlocker(text: string): string | null {
  const normalized = normalizeForLabelSearch(cleanTerminalText(text));
  // A real usage panel wins: onboarding copy can linger in the scrollback of a
  // session that went on to render usage just fine.
  if (normalized.includes("currentsession")) return null;
  for (const blocker of CLI_BLOCKERS) {
    if (blocker.pattern.test(normalized)) return blocker.message;
  }
  return null;
}

export function friendlyErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|network/i.test(msg)) {
    return "Network unavailable — check your internet connection and try again.";
  }

  if (/ENOENT|EACCES|permission denied/i.test(msg)) {
    return "Claude CLI not accessible — ensure Claude is installed and on your PATH.";
  }

  if (/timed out|SIGTERM|SIGKILL|killed/i.test(msg)) {
    return "Claude CLI timed out — it may be waiting on an interactive prompt. Run `claude` once as the user running Paperclip to finish setup.";
  }

  if (/Command failed:|sh\s+-c|script\s+-q|printf\b/i.test(msg)) {
    return "Claude CLI command failed — ensure Claude is installed and your network is available.";
  }

  return msg;
}

export function formatTimeDelta(isoDate: string, nowMs: number = Date.now()): string {
  const delta = new Date(isoDate).getTime() - nowMs;
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

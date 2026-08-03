import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, STATE_KEYS, TOOL_NAMES } from "./constants.js";
import {
  type AnthropicUsageResponse,
  type QuotaWindow,
  canonicalQuotaLabel,
  cleanTerminalText,
  detectCliBlocker,
  extractAccountEmail,
  friendlyErrorMessage,
  isQuotaLabel,
  normalizeForLabelSearch,
  parseAnthropicResponse,
  parseClaudeCliUsageText,
  percentFromLine,
  stripAnsi,
  stripBackspaces,
  trimToLatestUsagePanel,
} from "./parsing.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderSnapshot {
  provider: string;
  source: string | null;
  account: string | null;
  ok: boolean;
  error: string | null;
  windows: QuotaWindow[];
  fetchedAt: string;
}

interface UsageHistoryEntry {
  fetchedAt: string;
  windows: QuotaWindow[];
}

interface PluginConfig {
  pollIntervalMinutes?: number;
  providers?: string[];
  claudeConfigDir?: string;
  enableCliFallback?: boolean;
  claudeOAuthTokenRef?: string | EnvSecretRefBinding | null;
}

// ---------------------------------------------------------------------------
// Anthropic OAuth Usage API
// ---------------------------------------------------------------------------

async function fetchAnthropicUsage(token: string): Promise<QuotaWindow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Anthropic usage API returned ${resp.status}`);
    const body = (await resp.json()) as AnthropicUsageResponse;
    return parseAnthropicResponse(body);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Token resolution (auto-detect from local ~/.claude credentials)
// ---------------------------------------------------------------------------

// The worker runs as whatever user Paperclip's service runs as, which is often
// not the user who signed into Claude Code. That makes "which paths did we
// actually look at" the single most useful piece of diagnostic information
// when no token is found, so token lookup reports its search path rather than
// silently returning null.
interface TokenLookup {
  token: string | null;
  searched: string[];
}

function claudeConfigDir(configuredDir?: string | null): string {
  if (typeof configuredDir === "string" && configuredDir.trim().length > 0) {
    return configuredDir.trim();
  }
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function tokenFromCredentialsJson(raw: string): string | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const oauth = parsed["claudeAiOauth"] as Record<string, unknown> | undefined;
  const token = oauth?.["accessToken"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function readLocalClaudeToken(
  configuredDir: string | null | undefined,
  secrets: Pick<PluginContext, "secrets">["secrets"],
  tokenRef: PluginConfig["claudeOAuthTokenRef"],
): Promise<TokenLookup> {
  const searched: string[] = [];

  // Checked first: an operator-configured secret ref (Claude OAuth Token
  // setting). This is the only mechanism that actually works when Paperclip
  // runs the plugin worker in its own sandboxed process — the host
  // deliberately does not pass its own environment through to workers (to
  // avoid leaking unrelated host secrets), so CLAUDE_CODE_OAUTH_TOKEN being
  // set on the Paperclip container/host itself is invisible here regardless
  // of what this function checks next. Resolving through ctx.secrets is the
  // documented, supported path for a plugin to receive a value like that.
  if (tokenRef) {
    searched.push("claudeOAuthTokenRef config setting");
    try {
      const resolved = await secrets.resolve(tokenRef);
      if (typeof resolved === "string" && resolved.trim().length > 0) {
        return { token: resolved.trim(), searched };
      }
    } catch {
      // Ref set but not resolvable (deleted, revoked, no access) — fall through.
    }
  }

  // The env var itself: kept as a fallback for non-sandboxed usage (running
  // this worker outside Paperclip's process model, e.g. local development),
  // where nothing strips the ambient environment.
  searched.push("CLAUDE_CODE_OAUTH_TOKEN environment variable");
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof envToken === "string" && envToken.trim().length > 0) {
    return { token: envToken.trim(), searched };
  }

  const configDir = claudeConfigDir(configuredDir);

  for (const filename of [".credentials.json", "credentials.json"]) {
    const file = path.join(configDir, filename);
    searched.push(file);
    try {
      const token = tokenFromCredentialsJson(await fs.readFile(file, "utf8"));
      if (token) return { token, searched };
    } catch {
      // continue
    }
  }

  if (process.platform === "darwin") {
    searched.push("macOS keychain (Claude Code-credentials)");
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ], { timeout: 3000 });
      const token = tokenFromCredentialsJson(stdout.trim());
      if (token) return { token, searched };
    } catch {
      // continue
    }
  }

  return { token: null, searched };
}

function noCredentialsMessage(searched: string[]): string {
  return [
    "No Claude credentials found for the user running Paperclip",
    `(uid ${typeof process.getuid === "function" ? process.getuid() : "n/a"}, home ${os.homedir()}).`,
    `Looked in: ${searched.join(", ")}.`,
    "Sign in with `claude` as that user, or set the Claude config directory in this plugin's settings.",
  ].join(" ");
}

// The signed-in account lives in Claude Code's main config (`.claude.json`),
// which sits inside CLAUDE_CONFIG_DIR when that's set and at ~/.claude.json
// otherwise — a different file from the credentials read above.
async function readLocalClaudeAccount(configuredDir?: string | null): Promise<string | null> {
  const candidates: string[] = [];
  if (typeof configuredDir === "string" && configuredDir.trim().length > 0) {
    candidates.push(path.join(configuredDir.trim(), ".claude.json"));
  }
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    candidates.push(path.join(fromEnv.trim(), ".claude.json"));
  }
  candidates.push(path.join(os.homedir(), ".claude.json"));

  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const email = extractAccountEmail(JSON.parse(raw));
      if (email) return email;
    } catch {
      // continue
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI fallback — spawns `claude /usage` and parses the terminal output
// ---------------------------------------------------------------------------

function createClaudeQuotaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return env;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Marks an error whose message is already operator-facing, so the outer
// handler passes it through instead of running it back through
// friendlyErrorMessage and flattening the detail we just assembled.
class FriendlyError extends Error {
  readonly friendly = true;
}

function isFriendly(err: unknown): err is FriendlyError {
  return err instanceof Error && (err as { friendly?: boolean }).friendly === true;
}

// Raised when the CLI is parked on an interactive prompt (onboarding, folder
// trust, login). Retrying can't help — the operator has to act — so this
// short-circuits the retry in fetchClaudeCliQuota.
class CliBlockedError extends FriendlyError {
  readonly blocked = true;
}

interface ShellCapture {
  output: string;
  timedOut: boolean;
}

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// `execFile`'s timeout signals only the `sh` it spawned; the `script` and
// `claude` grandchildren survive and keep the pipe open, so a stuck TUI would
// leak processes and stall the worker. Spawning into its own process group
// lets us kill the whole tree.
function runShellCapture(
  command: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ShellCapture> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    let settled = false;

    const killTree = () => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      fn();
    };

    const onChunk = (chunk: Buffer) => {
      if (output.length < MAX_CAPTURE_BYTES) output += chunk.toString("utf8");
      // Bail as soon as an interactive prompt is recognised rather than
      // waiting out the timeout — the keystroke feed can never clear it.
      const blocker = detectCliBlocker(output);
      if (blocker) finish(() => reject(new CliBlockedError(blocker)));
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => finish(() => resolve({ output, timedOut })));
  });
}

async function runClaudeCliCommand(timeoutMs: number): Promise<QuotaWindow[]> {
  const feed = "(sleep 3; printf '/usage\\r'; sleep 8; printf '\\033'; sleep 1; printf '\\003')";
  const claudeCommand = "claude --tools \"\"";
  const command = process.platform === "darwin"
    ? `${feed} | script -q /dev/null ${claudeCommand}`
    : `${feed} | script -q -e -f -c ${quoteForShell(claudeCommand)} /dev/null`;

  let capture: ShellCapture;
  try {
    capture = await runShellCapture(command, createClaudeQuotaEnv(), timeoutMs);
  } catch (error) {
    if (error instanceof CliBlockedError) throw error;
    throw new Error(friendlyErrorMessage(error));
  }

  // Late-arriving prompts (drawn after the last chunk we inspected) still get
  // caught here before we blame the parser.
  const blocker = detectCliBlocker(capture.output);
  if (blocker) throw new CliBlockedError(blocker);

  try {
    return parseClaudeCliUsageText(capture.output);
  } catch (error) {
    if (capture.timedOut) {
      throw new Error(
        friendlyErrorMessage(new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`)),
      );
    }
    throw new Error(friendlyErrorMessage(error));
  }
}

async function fetchClaudeCliQuota(
  logger: Pick<PluginContext["logger"], "warn">,
  timeoutMs = 20_000,
): Promise<QuotaWindow[]> {
  try {
    return await runClaudeCliCommand(timeoutMs);
  } catch (firstError) {
    // An interactive prompt won't clear itself; a second attempt just burns
    // another timeout.
    if (firstError instanceof CliBlockedError) throw firstError;
    const msg = firstError instanceof Error ? firstError.message : String(firstError);
    logger.warn("CLI quota fetch failed on first attempt, retrying", { error: msg });
    return await runClaudeCliCommand(timeoutMs);
  }
}


// ---------------------------------------------------------------------------
// Core fetch logic
// ---------------------------------------------------------------------------

// Serialize pollAndStore so the scheduled job, the `refresh` action, and the
// tool-driven stale-snapshot fallback never read-modify-write `usage-history`
// concurrently. Each caller queues onto a shared promise chain and runs its
// own poll + append after the previous call finishes, so no history entries
// are lost. Failures don't poison the chain.
let pollChain: Promise<unknown> = Promise.resolve();

function pollAndStore(ctx: PluginContext): Promise<ProviderSnapshot> {
  const next = pollChain.then(() => runPollAndStore(ctx));
  pollChain = next.catch(() => undefined);
  return next;
}

async function runPollAndStore(ctx: PluginContext): Promise<ProviderSnapshot> {
  const config = (await ctx.config.get()) as PluginConfig;
  const enabledProviders = config.providers ?? DEFAULT_CONFIG.providers;
  const configuredDir = config.claudeConfigDir ?? null;
  const cliFallbackEnabled = config.enableCliFallback ?? DEFAULT_CONFIG.enableCliFallback;
  const account = await readLocalClaudeAccount(configuredDir);

  if (!enabledProviders.includes("claude")) {
    const snapshot: ProviderSnapshot = {
      provider: "claude",
      source: null,
      account,
      ok: false,
      error: "Provider 'claude' is not enabled in config",
      windows: [],
      fetchedAt: new Date().toISOString(),
    };
    await ctx.state.set({ scopeKind: "instance", stateKey: STATE_KEYS.latestQuota }, snapshot);
    return snapshot;
  }

  let snapshot: ProviderSnapshot;
  try {
    const { token, searched } = await readLocalClaudeToken(configuredDir, ctx.secrets, config.claudeOAuthTokenRef);
    let windows: QuotaWindow[];
    let source: string;

    // Why the OAuth path was skipped or failed is the diagnosis that matters —
    // the CLI fallback's own error is a symptom, not the cause. Both are
    // logged, and the OAuth reason is carried into the final error message so
    // it reaches the UI rather than dying in the worker log.
    let oauthFailure: string;

    if (token) {
      try {
        windows = await fetchAnthropicUsage(token);
        source = "anthropic-oauth";
        oauthFailure = "";
      } catch (err) {
        oauthFailure = friendlyErrorMessage(err);
        ctx.logger.warn("Anthropic usage API failed, falling back to Claude CLI", {
          error: oauthFailure,
        });
        if (!cliFallbackEnabled) {
          throw new FriendlyError(`Anthropic usage API failed: ${oauthFailure}`);
        }
        try {
          windows = await fetchClaudeCliQuota(ctx.logger);
        } catch (cliError) {
          const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
          throw new FriendlyError(
            `Anthropic usage API failed: ${oauthFailure} CLI fallback also failed: ${cliMessage}`,
          );
        }
        source = "claude-cli";
      }
    } else {
      oauthFailure = noCredentialsMessage(searched);
      ctx.logger.warn("No Claude OAuth token found, falling back to Claude CLI", {
        searched,
        homedir: os.homedir(),
      });
      if (!cliFallbackEnabled) throw new FriendlyError(oauthFailure);
      try {
        windows = await fetchClaudeCliQuota(ctx.logger);
        source = "claude-cli";
      } catch (cliError) {
        const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
        throw new FriendlyError(`${oauthFailure} CLI fallback also failed: ${cliMessage}`);
      }
    }
    snapshot = {
      provider: "claude",
      source,
      account,
      ok: true,
      error: null,
      windows,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = isFriendly(err) ? err.message : friendlyErrorMessage(err);
    snapshot = {
      provider: "claude",
      source: null,
      account,
      ok: false,
      error: message,
      windows: [],
      fetchedAt: new Date().toISOString(),
    };
    await ctx.state.set({ scopeKind: "instance", stateKey: STATE_KEYS.lastError }, message);
    ctx.logger.warn("Usage poll failed", { error: message });
  }

  await ctx.state.set({ scopeKind: "instance", stateKey: STATE_KEYS.latestQuota }, snapshot);

  if (snapshot.ok && snapshot.windows.length > 0) {
    const existing =
      ((await ctx.state.get({ scopeKind: "instance", stateKey: STATE_KEYS.history })) as
        | UsageHistoryEntry[]
        | null) ?? [];
    existing.unshift({ fetchedAt: snapshot.fetchedAt, windows: snapshot.windows });
    if (existing.length > 96) existing.length = 96;
    await ctx.state.set({ scopeKind: "instance", stateKey: STATE_KEYS.history }, existing);

    for (const w of snapshot.windows) {
      if (w.usedPercent != null) {
        await ctx.metrics.write("usage.percent", w.usedPercent, {
          provider: "claude",
          window: w.label,
        });
      }
    }
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Human-readable summary for agent tool
// ---------------------------------------------------------------------------

function formatTimeDelta(isoDate: string): string {
  const delta = new Date(isoDate).getTime() - Date.now();
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Tool handlers treat a snapshot as stale when it's older than the configured
// poll interval. Floored at 5 minutes so an aggressive `pollIntervalMinutes: 1`
// doesn't burn CLI invocations on every tool call.
async function staleThresholdMs(ctx: PluginContext): Promise<number> {
  const config = (await ctx.config.get()) as PluginConfig;
  const intervalMinutes = config.pollIntervalMinutes ?? DEFAULT_CONFIG.pollIntervalMinutes;
  return Math.max(intervalMinutes, 5) * 60_000;
}

function buildSummary(snapshot: ProviderSnapshot): string {
  if (!snapshot.ok) return `Claude usage unavailable: ${snapshot.error}`;
  if (snapshot.windows.length === 0) return "No usage data available.";

  const accountSuffix = snapshot.account ? ` for ${snapshot.account}` : "";
  const lines: string[] = [`Claude usage${accountSuffix} (as of ${snapshot.fetchedAt}):`];
  for (const w of snapshot.windows) {
    let line = `  ${w.label}: `;
    if (w.usedPercent != null) {
      const remaining = 100 - w.usedPercent;
      line += `${remaining}% remaining`;
    } else if (w.valueLabel) {
      line += w.valueLabel;
    } else {
      line += "unknown";
    }
    if (w.resetsAt) {
      line += ` (resets in ${formatTimeDelta(w.resetsAt)})`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.data.register("latest-quota", async () => {
      const snapshot = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.latestQuota,
      })) as ProviderSnapshot | null;
      return snapshot;
    });

    ctx.data.register("usage-history", async () => {
      const history = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.history,
      })) as UsageHistoryEntry[] | null;
      return history ?? [];
    });

    ctx.actions.register("refresh", async () => {
      const snapshot = await pollAndStore(ctx);
      return snapshot;
    });

    ctx.jobs.register(JOB_KEYS.pollUsage, async () => {
      const jobConfig = (await ctx.config.get()) as PluginConfig;
      const intervalMinutes = jobConfig.pollIntervalMinutes ?? DEFAULT_CONFIG.pollIntervalMinutes;

      const lastSnapshot = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.latestQuota,
      })) as ProviderSnapshot | null;

      if (lastSnapshot) {
        const elapsedMs = Date.now() - new Date(lastSnapshot.fetchedAt).getTime();
        if (elapsedMs < intervalMinutes * 60_000 * 0.9) {
          ctx.logger.info("Skipping poll — configured interval not yet elapsed", { intervalMinutes });
          return;
        }
      }

      ctx.logger.info("Running scheduled usage poll");
      await pollAndStore(ctx);
    });

    ctx.tools.register(
      TOOL_NAMES.getUsage,
      {
        displayName: "Get AI Provider Usage",
        description:
          "Returns current usage quota windows for configured AI providers.",
        parametersSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
          },
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { provider } = (params ?? {}) as { provider?: string };
        const requestedProvider = provider?.trim().toLowerCase() || "claude";

        if (requestedProvider !== "claude") {
          return {
            content: JSON.stringify({
              ok: false,
              error: `Provider '${requestedProvider}' is not supported. Currently only 'claude' is available.`,
            }),
          };
        }

        let snapshot = (await ctx.state.get({
          scopeKind: "instance",
          stateKey: STATE_KEYS.latestQuota,
        })) as ProviderSnapshot | null;

        const thresholdMs = await staleThresholdMs(ctx);
        if (
          !snapshot ||
          Date.now() - new Date(snapshot.fetchedAt).getTime() > thresholdMs
        ) {
          snapshot = await pollAndStore(ctx);
        }

        return { content: JSON.stringify(snapshot, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.getUsageSummary,
      {
        displayName: "Get Usage Summary",
        description:
          "Returns a brief human-readable summary of current usage across all providers.",
        parametersSchema: {
          type: "object",
          properties: {},
        },
      },
      async (_params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        let snapshot = (await ctx.state.get({
          scopeKind: "instance",
          stateKey: STATE_KEYS.latestQuota,
        })) as ProviderSnapshot | null;

        const thresholdMs = await staleThresholdMs(ctx);
        if (
          !snapshot ||
          Date.now() - new Date(snapshot.fetchedAt).getTime() > thresholdMs
        ) {
          snapshot = await pollAndStore(ctx);
        }

        return { content: buildSummary(snapshot) };
      },
    );

    ctx.logger.info("Agent Usage plugin initialized");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok", message: "Agent Usage plugin running" };
  },
});

runWorker(plugin, import.meta.url);

# Research: company-scoped config access & credential resolution

Captured 2026-08-03 while debugging why this plugin could not fetch usage data
on a self-hosted Paperclip instance, even after install/auth issues were
resolved. Keeping this so a future broader redesign (see "If scope expands"
below) doesn't have to re-derive it.

## Symptom

Every code path that calls `ctx.config.get()` — the scheduled `poll-usage`
job, the manual "refresh" action, and (indirectly, via `staleThresholdMs`)
both agent tools — failed with:

```
{"code":"INVOCATION_SCOPE_DENIED","message":"... \"config.get\": company context is required"}
```

This happened regardless of Claude credential state. It is unrelated to the
install/auth/Docker-path issues resolved earlier in this effort.

## Root cause

Traced through both `@paperclipai/plugin-sdk` (worker-side) and the Paperclip
host server (`server/src/services/plugin-worker-manager.ts`), at the exact
commit the live instance was running (`8540ce2973204a8938cd05ac18fbc37c6434f8f5`,
`origin/master` in the `paperclipai/paperclip` fork at
`github.com/lsimpsonsfdc/paperclip`):

1. `@paperclipai/plugin-sdk`'s `host-client-factory.js` (`config.get` handler)
   unconditionally requires a company-scoped invocation via
   `resolveRequiredCompanyId()` — it does **not** matter whether the plugin's
   own manifest declares itself instance-scoped (`instanceConfigSchema`,
   `instance.settings.register`), and it does **not** matter what companyId
   the worker itself passes as a parameter to `config.get(companyId)`. The
   check is against `context.invocationScope.companyId`, which is set by the
   *host*, not the worker.
2. The host only populates `invocationScope` when the *inbound* RPC call
   itself carries a companyId: `performAction` via `params.actorContext.companyId`,
   `executeTool` via `params.runContext.companyId`, `onEvent` via
   `params.event.companyId` (see `deriveInvocationScope()` in
   `plugin-worker-manager.ts`). There's also a generic top-level check —
   `params.companyId` — that applies regardless of method name.
3. **`runJob` is not handled in `deriveInvocationScope()` at all.** The
   scheduler (`plugin-job-scheduler.ts`, `dispatchJob()`) calls
   `workerManager.call(pluginId, "runJob", { job: {...} }, timeoutMs)` with no
   `companyId` anywhere in `params`. A scheduled job therefore has **no
   possible way** to satisfy `config.get()`'s requirement without a host-side
   change — this is not fixable from the plugin alone.
4. Confirmed this is not a fork-specific regression: `upstream/master`
   (`paperclipai/paperclip`, commit `42d0ddcb86297fa3adc2413bf9655092b9f4b1d6`,
   fetched 2026-08-03) has the identical gap. Worth an upstream PR regardless
   of what we do locally.

### The interactive paths turned out to need no plugin changes at all

Verified against the host's actual UI bridge source
(`ui/src/plugins/bridge.ts`, `ui/src/pages/PluginPage.tsx`), not just the SDK
types:

- `usePluginAction(key)`'s host-side implementation *always* reads
  `hostContext.companyId` and sends it as the top-level `companyId` on the
  `POST /actions/:key` request — automatically, regardless of what the
  plugin's own call site passes as `params`. The plugin doesn't need to read
  `context.companyId` and pass it manually; the bridge already does this.
- `PluginPage.tsx` resolves `hostContext.companyId` from the route's company
  prefix when present, and otherwise **falls back to `selectedCompanyId`** —
  whichever company is currently selected in the sidebar. So even though
  this plugin's `page`/`dashboardWidget`/`settingsPage` slots aren't
  mounted under a company-prefixed route, a real user with any company
  selected still gets a populated `hostContext.companyId`, which flows
  through automatically.
- `POST /plugins/tools/execute` (agent tool calls) *requires and validates*
  `runContext.companyId` server-side (400 if missing, `assertCompanyAccess`
  + `validateToolRunContextScope` otherwise) — a real agent invocation
  always has one, since agents always belong to a company.

Net result: `ctx.config.get()` calls made from `ctx.actions.register()` and
`ctx.tools.register()` handlers already succeed today, with **zero plugin
code changes**, as long as the invoking user/agent has company context at
all (true for any normal session). The only path with no such fallback
anywhere in the host was the scheduled job — the one thing this fix actually
had to touch.

This was originally expected to require UI/worker changes (see the git
history of this file / conversation for the earlier, wrong assumption) —
corrected after reading the actual bridge implementation instead of
guessing from the SDK's type declarations alone.

### `ctx.state` is unaffected

Only `config.get()` enforces this. `ctx.state.get/set` with
`scopeKind: "instance"` goes through `requireInvocationCompanyScope()`
(different function, in the same file), which returns early — no throw — when
the requested scope is `{kind: "none"}` (i.e. no companyId in the state key).
This plugin's usage snapshot/history storage was never actually broken.

## Two fix shapes considered

This plugin tracks exactly **one** Claude subscription (one set of OS-level
OAuth credentials on the host running Paperclip) — not one per company. That
matters for which fix shape is right:

- **Narrow (chosen, implemented now)**: the job scheduler resolves *any one*
  accessible company and attaches it to the existing single scheduled run,
  purely to satisfy the host's scope check. One poll per tick, one snapshot,
  stored instance-wide exactly as today. Every company's agents read the same
  shared `ctx.state` data — unaffected by which company was used to satisfy
  the config-scope check.
- **Broad (not implemented — here for later)**: real per-company job fan-out.
  `plugin_job_runs.companyId` (nullable, `"Company scope — NULL for
  instance-level jobs"`) **already exists in the schema** — the DB was
  clearly built anticipating this, `dispatchJob()` just never populates it.
  This would only make sense if usage were genuinely different per company
  (e.g. separate Claude accounts/subscriptions per company). It isn't today.

## If scope expands later (per-company Claude accounts)

If a future requirement needs genuinely separate tracking per company (e.g.
each company brings its own Claude subscription), the broad fix becomes the
right one, and needs:

1. **Host**: `plugin_jobs` needs a way to signal "fan out per company" (a new
   `scopeKind` on the manifest's `PluginJobDeclaration`, or similar). Extend
   `dispatchJob()`'s tick loop to enumerate accessible companies and call
   `runJob` once per company, each with `companyId` at the top level of
   `params` (and in the `pluginJobRuns` row it already supports).
2. **SDK protocol**: `PluginJobDeclaration` (in
   `packages/shared/src/types/plugin.ts`) and `PluginJobContext` (in
   `packages/plugins/sdk/src/types.ts`) need a `companyId`/scope field so the
   worker can tell which company a given job run is for.
3. **This plugin**: `ctx.state` scoping would need to move from
   `scopeKind: "instance"` to `scopeKind: "company", scopeId: companyId` for
   `latest-quota` / `usage-history` / `last-error`, so each company's poll
   result doesn't clobber the others. Config
   (`claudeConfigDir`/`enableCliFallback`/`providers`/`pollIntervalMinutes`)
   would need to become genuinely per-company operator settings (it already
   *can* be — `instanceConfigSchema` validates whatever a company sets, it's
   just not company-differentiated in practice today, see
   `@paperclipai/shared`'s manifest types — there's no separate
   `companyConfigSchema` field, "instance" in the name is legacy).
4. UI would move from `settingsPage`/generic `page` slots to
   `companySettingsPage` (a dedicated slot type that "always receives the
   active company id ... when available" per the SDK's `ui/types.d.ts`).

None of this is needed for the narrow fix.

## Credential resolution gap (separate finding, same debugging session)

`readLocalClaudeToken()` (`src/worker.ts`) only checks `.credentials.json` /
`credentials.json` files and (on macOS) the Keychain. It never reads
`process.env.CLAUDE_CODE_OAUTH_TOKEN` — the standard Claude Code env var for
headless/container auth (issued via `claude setup-token`). On this instance's
Paperclip host container, that env var is set and is very likely the
intended, freshest credential — more reliable than whatever's sitting in the
credentials file, which had gone stale (last touched over a month prior with
no active refresh). The CLI-fallback subprocess *does* inherit this var today
(`createClaudeQuotaEnv()` only strips `ANTHROPIC_*`-prefixed vars), but the
primary direct-API path never gets a chance to use it. Fixed alongside the
scope work — see `CHANGELOG.md`.

## Decision: the host-fork job-scope fix (PR #17) was not merged

`lsimpsonsfdc/paperclip#17` implements the narrow scheduled-job scope fix
described above. It turned out not to be necessary for this plugin's actual
goal — agents making decisions off usage data — and the owner of that fork
preferred not to carry a host-repo change for it. Reasoning:

- The manual refresh action and both agent tools (`get-usage`,
  `get-usage-summary`) already get a working company scope today, with no
  host change, per "The interactive paths turned out to need no plugin
  changes at all" above.
- Both tool handlers already call `pollAndStore(ctx)` whenever the cached
  snapshot is stale (`staleThresholdMs`), from *within* their own
  already-scoped tool invocation. So an agent calling either tool
  effectively gets pull-based polling for free — the exact mechanism the
  scheduled job would have provided, just triggered by demand instead of a
  timer.
- The only thing genuinely lost by not fixing `runJob` is a background
  refresh with nobody watching — the dashboard widget can show a snapshot
  that's up to `pollIntervalMinutes` stale if no agent has called a tool and
  nobody's clicked refresh recently. The manifest still declares the
  `poll-usage` job; it will keep failing quietly every tick with
  `INVOCATION_SCOPE_DENIED` until/unless a host fix like PR #17 lands. Worth
  revisiting — either removing the job declaration (since it can't succeed
  without a host change and just adds noise to the plugin's job-run history)
  or leaving it as a documented known-broken piece — but out of scope for
  this pass.

PR #17 and its branch remain available on the fork if this trade-off is
revisited later; see `doc/plugins/COMPANY_SCOPED_JOB_INVOCATION.md` there.

## Credential resolution, take two: `ctx.secrets` instead of an env var

The `CLAUDE_CODE_OAUTH_TOKEN` fix above shipped and was deployed, then
failed live with the token reported as not found — even though it's set on
the Paperclip container. Root cause, found in the live container's own
source (`server/src/services/plugin-worker-manager.ts`,
`spawnProcess()`):

```ts
// Security: Do NOT spread process.env into the worker. Plugins should only
// receive a minimal, controlled environment to prevent leaking host
// secrets (like DATABASE_URL, internal API keys, etc.).
```

Plugin worker processes only ever receive `PATH`, `NODE_PATH`, `NODE_ENV`,
`TZ`, and whatever the plugin loader explicitly opts in — a deliberate
security boundary, not a bug. `CLAUDE_CODE_OAUTH_TOKEN` on the container
was never going to reach the worker's `process.env`, regardless of what the
plugin checks for. The CLI-fallback subprocess never had it either, for the
same reason (`createClaudeQuotaEnv()` spreads the worker's own `process.env`,
which never had the var to begin with).

Fixed properly using the SDK's documented secrets mechanism instead
(PLUGIN_SPEC.md §22, `ctx.secrets`): added a `claudeOAuthTokenRef` field to
`instanceConfigSchema` with `format: "secret-ref"` (renders as a secret
picker in the settings UI, per §19.2), and `secrets.read-ref` to the
manifest's capabilities. At runtime, `ctx.secrets.resolve(tokenRef)` — called
with no `companyId` option, resolving against whatever invocation scope the
host already established, exactly like `config.get()` — returns the plain
token string. This is checked first, ahead of the env var (kept as a
fallback for non-sandboxed usage, e.g. running this worker outside
Paperclip entirely) and the credentials-file/Keychain lookup.

Confirmed `secrets.resolve` has the identical unconditional company-scope
requirement as `config.get` (`host-client-factory.js`, same
`resolveRequiredCompanyId()` call) — consistent with everything above: this
works from the action/tool paths today, and would need the same `runJob`
scope fix to work from the scheduled job.

## Reference: exact commits at time of writing

- Plugin repo: this commit's parent on `main`.
- Paperclip fork (`github.com/lsimpsonsfdc/paperclip`), `origin/master`:
  `8540ce2973204a8938cd05ac18fbc37c6434f8f5` (2026-08-01) — matches the
  running container's image tag exactly.
- Paperclip upstream (`github.com/paperclipai/paperclip`), `master`:
  `42d0ddcb86297fa3adc2413bf9655092b9f4b1d6` (2026-08-03).
- See the companion design doc in the host fork:
  `doc/plugins/COMPANY_SCOPED_JOB_INVOCATION.md`.

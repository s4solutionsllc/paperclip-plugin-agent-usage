# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Added a `prepare` script so `dist/` is built automatically on `npm install`. Local-path installs (`{ "isLocalPath": true }`) previously required a manual `npm run build` first, since `dist/` is gitignored and only `prepublishOnly` built it — an unbuilt local checkout would fail to install with no obvious cause.
- Pinned `@paperclipai/plugin-sdk` to an exact version (`2026.722.0`) instead of `"latest"`, and re-synced `package-lock.json` and `bun.lock` to match — they had drifted to two different, stale SDK versions, so installs were not reproducible across package managers or over time.
- Token resolution now tries an operator-configured secret ref (new `claudeOAuthTokenRef` setting), then `CLAUDE_CODE_OAUTH_TOKEN`, before falling back to `.credentials.json` / Keychain lookup. The env var alone turned out not to be reachable in practice — Paperclip's plugin worker processes intentionally don't inherit the host's environment (a real security boundary, not a bug), so a token set on the Paperclip container itself was invisible to the plugin regardless of what it checked. The secret ref, resolved through `ctx.secrets` at call time, is the only mechanism that actually reaches the worker under that sandboxing model. See `backlog/company-scoped-config_research.md`.
- Removed the plugin's custom settings-page UI. It turned out to have been display-only from day one (status text, no editable fields) — worse, declaring a custom `settingsPage` slot at all suppresses Paperclip's own auto-generated config form, which is the only thing that renders a working secret picker for `claudeOAuthTokenRef`. There was previously no way to edit *any* setting (poll interval, config dir, CLI fallback) through this plugin's UI, only via direct API calls. Status/account/source are still visible on the main **Agent Usage** page and dashboard widget.
- Fixed `toPercent()` reporting 100% for any non-trivial real usage. The Anthropic OAuth usage API returns `utilization` as a whole percentage already (`1.0` means 1% used), not a `0..1` fraction — confirmed against the same response's own `limits[].percent` field. `toPercent()` was still multiplying by 100, so a real account showing 1%/31% usage displayed as 100%/100%. This reverses the assumption behind LAC-2004's original fix, which was chasing the opposite problem based on the wrong unit assumption.
- `worker.ts` had its own complete, stale duplicate of nearly all of `parsing.ts` (`toPercent`, `parseAnthropicResponse`, `extractAccountEmail`, and 13 other functions) — `parsing.ts`'s own header comment says it was "extracted from worker.ts so they can be unit-tested," but worker.ts was never actually updated to import from it. Every regression test in `parsing.test.ts` was covering code the running worker never called, except `detectCliBlocker`/`friendlyErrorMessage`, which were already imported correctly. worker.ts now imports everything from `parsing.ts` instead of maintaining its own copies — the two implementations happened to be byte-identical (verified before deleting), so this is a pure de-duplication, not a behavior change beyond the `toPercent` fix above.

### Added

- **Claude OAuth Token** setting (`claudeOAuthTokenRef`) — a secret-ref field (`claude setup-token`) resolved through Paperclip's own secret store, ahead of the credentials-file/env-var/Keychain fallbacks.

- Explicit **Claude Config Directory** setting, so the credentials path can be pointed at the signed-in user's `~/.claude` when Paperclip's worker runs as a different user.
- Explicit **Enable Claude CLI Fallback** setting, to skip the TUI scraping entirely and report the credential/API error directly.
- Detection of Claude Code's interactive first-run screens (onboarding theme picker, folder-trust prompt, signed-out CLI) in the CLI fallback, reported as an actionable message instead of a raw shell error.

- Signed-in account email shown in the dashboard widget, usage page, settings page, and agent usage summary, so multi-account users can tell which account the quota belongs to (LAC-3028).

- Centered README hero, logo (pink quota-bars on rounded square), 5 modern badges.
- `.github/` community files: FUNDING, dependabot, ISSUE_TEMPLATE, PR template, SECURITY, CONTRIBUTING.
- CI typecheck + build workflow on Node 18/20/22.
- Branded 1280×640 social preview banner.
- CodeQL security scanning + Dependabot auto-merge workflow.

### Changed

- Usage-API failures are now logged and carried into the surfaced error instead of being swallowed by an empty `catch`, so the real cause is visible rather than only the CLI fallback's symptom.
- The CLI fallback runs in its own process group and is hard-killed on timeout or when a blocking prompt is detected, so a stuck `claude` TUI no longer leaks `script`/`claude` processes or burns the full timeout.
- Missing credentials now report which paths were searched, along with the worker's uid and home directory.

- Install code blocks switched from `bash` to `http` fence (matches the pseudo-HTTP REST shape).
- PR template + CONTRIBUTING aligned with actual `npm run typecheck` / `npm run build` workflow.
- npm keywords expanded (paperclip-plugin, ai, ai-agent, agent, quota, usage, tracking, oauth).

## [0.1.4] and earlier

For pre-0.1.4 history, see [`git log`](https://github.com/lacymorrow/paperclip-plugin-agent-usage/commits/main).

[Unreleased]: https://github.com/lacymorrow/paperclip-plugin-agent-usage/compare/v0.1.4...HEAD

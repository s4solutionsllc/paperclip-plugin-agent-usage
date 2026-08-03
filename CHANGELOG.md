# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Added a `prepare` script so `dist/` is built automatically on `npm install`. Local-path installs (`{ "isLocalPath": true }`) previously required a manual `npm run build` first, since `dist/` is gitignored and only `prepublishOnly` built it — an unbuilt local checkout would fail to install with no obvious cause.
- Pinned `@paperclipai/plugin-sdk` to an exact version (`2026.722.0`) instead of `"latest"`, and re-synced `package-lock.json` and `bun.lock` to match — they had drifted to two different, stale SDK versions, so installs were not reproducible across package managers or over time.

### Added

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

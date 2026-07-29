# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

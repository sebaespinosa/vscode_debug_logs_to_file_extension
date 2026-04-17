# Changelog

All notable changes to the **Debug Log Capture** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-16

Initial preview release.

### Added
- Automatic capture of Debug Adapter Protocol (DAP) output to per-session log files in `<workspace>/debug-logs/`.
- Subprocess sessions (e.g. debugpy children spawned by `uvicorn --reload` or TaskIQ workers) merge into the parent session's log file with `── Subprocess attached/detached ──` markers, so you get one file per launch config regardless of how many processes it forks.
- Standalone MCP stdio server exposing four tools (`list_debug_logs`, `read_debug_log`, `search_debug_logs`, `get_debug_errors`) and one resource (`debug://logs/summary`) with live `resources/updated` notifications on file change.
- One-click MCP config writers:
  - **Debug Log Capture: Configure Claude Code MCP** — writes `<workspace>/.mcp.json`.
  - **Debug Log Capture: Configure GitHub Copilot MCP** — writes `<workspace>/.vscode/mcp.json`.
  Both use the extension's own install path so the config is always correct for the current machine/profile.
- Warning notification when a debug session uses `"console": "integratedTerminal"`, since direct terminal output bypasses the Debug Adapter Protocol and cannot be captured. The warning is deduplicated per launch-configuration name and suppressed for debugpy subprocess sessions.
- Configurable DAP category exclusion via `debugLogCapture.excludeCategories` (defaults to `["telemetry"]`).
- Settings: `logDirectory`, `cleanOnStart`, `maxLogSizeMB`, `includeTimestamps`, `excludeCategories`, `mcpServer.autoStart`.

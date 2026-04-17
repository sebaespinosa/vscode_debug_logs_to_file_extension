# Debug Log Capture

> Capture VS Code's ephemeral debug console output to log files and expose them to AI coding assistants (Claude Code, GitHub Copilot) via an **MCP server** — no more copy-pasting stack traces into chat.

## Features

- **Zero-config capture** — activates on any debug session (Python, Node.js, Go, Java — anything that speaks DAP) and writes all output to `<workspace>/debug-logs/<session-name>.log`.
- **One file per launch** — subprocess sessions (e.g. debugpy children from `uvicorn --reload` or TaskIQ workers) are merged into the parent's log file, so a single launch produces a single file no matter how many child processes it forks.
- **Built-in MCP server** — ships with a standalone Model Context Protocol stdio server that exposes four tools (`list_debug_logs`, `read_debug_log`, `search_debug_logs`, `get_debug_errors`) and a live-updating summary resource. Point your AI assistant at it and ask it to debug for you.
- **One-click AI integration** — dedicated commands to wire the MCP server into [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`.mcp.json`) or [GitHub Copilot in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) (`.vscode/mcp.json`) with the correct absolute path for your install.
- **Smart cleanup** — old logs are cleared at the start of each new debug run, size-capped files are rolled at a configurable limit, and DAP categories you don't care about (like `telemetry`) can be excluded.

## Quick start

1. Install the extension from the Marketplace.
2. Start any debug session. The log file is created automatically and its path is shown in the `Debug Log Capture` output channel.
3. *(Optional)* Wire it up to your AI assistant:
   - Open the Command Palette → **Debug Log Capture: Configure Claude Code MCP** *(writes `<workspace>/.mcp.json`)*, or
   - **Debug Log Capture: Configure GitHub Copilot MCP** *(writes `<workspace>/.vscode/mcp.json`)*.
   Reload the window and ask your assistant to "list my debug logs" to verify.

## Commands

| Command | Description |
|---|---|
| **Debug Log Capture: Open Current Log** | Opens the active session's log (with a picker if multiple sessions are running) |
| **Debug Log Capture: Clean All Logs** | Deletes every file in the log directory |
| **Debug Log Capture: Start MCP Server** | Starts the bundled MCP server (stdio) as a child process of the extension — mainly useful for development; see *AI integration* below for production use |
| **Debug Log Capture: Stop MCP Server** | Stops the above |
| **Debug Log Capture: Configure Claude Code MCP** | Adds a `debug-logs` server entry to `<workspace>/.mcp.json` |
| **Debug Log Capture: Configure GitHub Copilot MCP** | Adds a `debug-logs` server entry to `<workspace>/.vscode/mcp.json` |
| **Debug Log Capture: Check Launch Configuration** | Analyzes the workspace's `launch.json` and opens a report showing which configurations will produce full, partial, or empty log capture — plus recommended fixes |

## AI integration

The extension ships a Node.js MCP server at `<extension-dir>/out/mcpServer.js`. The two `Configure …` commands above write the correct absolute path for your install into the AI assistant's config file — no manual path-hunting.

Once configured, natural-language prompts that work well:

- *"List my debug logs"*
- *"Read the last 100 lines of the API server log"*
- *"Find all errors in the taskiq worker log"*
- *"Search every debug log for 'connection refused'"*

### MCP tools provided

| Tool | Description |
|---|---|
| `list_debug_logs` | List every `.log` file with size and last-modified timestamp |
| `read_debug_log` | Read a log file in full, or the last N lines |
| `search_debug_logs` | Regex search across every log file; returns matches with `file:line` locators |
| `get_debug_errors` | Pull out lines matching `error\|exception\|traceback\|failed\|fatal\|critical\|panic` with surrounding context |

The MCP server also exposes a `debug://logs/summary` resource that clients can subscribe to — the server sends `notifications/resources/updated` events whenever the log directory changes, so your assistant can be aware of live log updates without polling.

## Recommended launch configuration

How much output reaches the log file depends on two things: the debugger being used and the `"console"` setting in your `launch.json`.

| `"console"` value | Python (debugpy) | Node.js / Go / other debuggers |
|---|---|---|
| `"internalConsole"` | ✅ Full capture | ✅ Full capture |
| `"integratedTerminal"` | ⚠️ Partial — debugpy's Python-level output hooks forward most output through DAP, but a few early lines from the parent process (pre-hook) may be missing. ANSI color escape sequences are preserved verbatim. | ❌ Empty — output bypasses DAP entirely |
| `"externalTerminal"` | ❌ Empty — output bypasses DAP | ❌ Empty — output bypasses DAP |

**Recommendation**: set `"console": "internalConsole"` for the most reliable, tool-agnostic capture. The output lands in VS Code's Debug Console panel instead of a terminal; for server workloads (uvicorn, TaskIQ, etc.) that's usually fine — you rarely need an interactive TTY for the process you're debugging.

### Example: uvicorn + FastAPI with reload

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "API: debug",
      "type": "debugpy",
      "request": "launch",
      "module": "uvicorn",
      "console": "internalConsole",
      "cwd": "${workspaceFolder}",
      "args": ["main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"],
      "justMyCode": false
    }
  ]
}
```

This captures the uvicorn startup banner, request logs, your application's `logging` output, and exception tracebacks into one log file per launch. The reload worker is a separate debugpy subprocess — its output is automatically merged into the parent's log with `── Subprocess attached ──` markers.

> **Tested so far**: Python / debugpy. Other debugger types (Node.js, Go, Java, etc.) should also work given DAP is a standard protocol — please [open an issue](https://github.com/sebaespinosa/vscode_debug_logs_to_file_extension/issues) if you find one that doesn't.

## Settings

| Setting | Default | Description |
|---|---|---|
| `debugLogCapture.logDirectory` | `"debug-logs"` | Directory for log files, relative to workspace root |
| `debugLogCapture.cleanOnStart` | `true` | Clean existing logs when a new debug session starts |
| `debugLogCapture.maxLogSizeMB` | `10` | Max size per log file; older lines are trimmed past this |
| `debugLogCapture.includeTimestamps` | `true` | Prefix each log line with an ISO 8601 timestamp |
| `debugLogCapture.excludeCategories` | `["telemetry"]` | DAP output categories to suppress. Valid values: `stdout`, `stderr`, `console`, `important`, `telemetry` |
| `debugLogCapture.mcpServer.autoStart` | `false` | Start the bundled MCP server automatically on activation |

## Known limitations

- **`"console": "integratedTerminal"` and `"externalTerminal"` partially or fully bypass capture** — see [Recommended launch configuration](#recommended-launch-configuration) above for a per-debugger breakdown. The extension raises a one-time warning when such a session starts so you don't silently end up with an empty or incomplete log file.
- **ANSI escape sequences in captured output are preserved verbatim** — rendered colors appear as `[32m…[0m` markers in the file. This is mostly cosmetic and AI assistants can still parse the content, but log viewers won't display colored output.
- **MCP server is stdio-only.** HTTP/SSE transport is not implemented; the `debugLogCapture.mcpServer.port` setting is reserved for a future version.

## Requirements

- VS Code **1.85** or later.
- Node.js runtime for the MCP server. Ships automatically with the extension — no separate install needed for the user.

## Release notes

See the [CHANGELOG](CHANGELOG.md).

## Issues & feedback

- [Report a bug](https://github.com/sebaespinosa/vscode_debug_logs_to_file_extension/issues)
- [Source code](https://github.com/sebaespinosa/vscode_debug_logs_to_file_extension)

## License

[MIT](LICENSE)

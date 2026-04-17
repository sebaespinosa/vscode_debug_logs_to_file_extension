#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

/**
 * MCP Server that exposes debug log files to Claude Code.
 *
 * Tools provided:
 *   - list_debug_logs     → list all log files with size/date
 *   - read_debug_log      → read a log file (full or last N lines)
 *   - search_debug_logs   → grep across all logs for a pattern
 *   - get_debug_errors    → extract only error/exception lines
 *
 * Usage with Claude Code:
 *   Add to .claude/settings.json → mcpServers:
 *   {
 *     "debug-logs": {
 *       "command": "node",
 *       "args": ["<path-to-extension>/out/mcpServer.js", "--workspace", "/path/to/your/project"]
 *     }
 *   }
 */

// ── Parse CLI args ────────────────────────────────────────────────────

function parseArgs(): { workspacePath: string; logDir: string } {
  const args = process.argv.slice(2);
  let workspacePath = process.cwd();
  let logDir = "debug-logs";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspacePath = args[++i];
    }
    if (args[i] === "--log-dir" && args[i + 1]) {
      logDir = args[++i];
    }
  }

  return { workspacePath, logDir: path.join(workspacePath, logDir) };
}

const { workspacePath, logDir } = parseArgs();

// ── Helpers ───────────────────────────────────────────────────────────

interface LogFileInfo {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

function getLogFiles(): LogFileInfo[] {
  if (!fs.existsSync(logDir)) {
    return [];
  }
  return fs
    .readdirSync(logDir)
    .filter((f: string) => f.endsWith(".log"))
    .map((f: string) => {
      const fullPath = path.join(logDir, f);
      const stats = fs.statSync(fullPath);
      return {
        name: f,
        path: fullPath,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a: LogFileInfo, b: LogFileInfo) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function readLogContent(filePath: string, tailLines?: number): string {
  if (!fs.existsSync(filePath)) {
    return `[File not found: ${filePath}]`;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  if (tailLines && tailLines > 0) {
    const lines = content.split("\n");
    return lines.slice(-tailLines).join("\n");
  }
  return content;
}

function searchLogs(pattern: string, maxResults: number = 50): string[] {
  const results: string[] = [];
  const files = getLogFiles();
  const regex = new RegExp(pattern, "gi");

  for (const file of files) {
    const content = fs.readFileSync(file.path, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        results.push(`${file.name}:${i + 1}: ${lines[i]}`);
        if (results.length >= maxResults) {
          return results;
        }
      }
      regex.lastIndex = 0; // reset for global regex
    }
  }
  return results;
}

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "debug-log-capture",
  version: "0.1.0",
});

// Tool: list_debug_logs
server.registerTool(
  "list_debug_logs",
  {
    description: "List all debug log files in the workspace with their sizes and last modified times.",
  },
  async () => {
    const files = getLogFiles();
    if (files.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No debug logs found in ${logDir}. Start a debug session in VS Code to generate logs.`,
          },
        ],
      };
    }

    const summary = files
      .map(
        (f) =>
          `• ${f.name}  (${(f.sizeBytes / 1024).toFixed(1)} KB, modified ${f.modifiedAt})`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${files.length} debug log(s) in ${logDir}:\n\n${summary}`,
        },
      ],
    };
  }
);

// Tool: read_debug_log
server.registerTool(
  "read_debug_log",
  {
    description: "Read the contents of a debug log file. Optionally read only the last N lines.",
    inputSchema: {
      filename: z
        .string()
        .describe(
          "Log filename (e.g. 'fastapi--debug-api-server.log'). Use list_debug_logs to see available files."
        ),
      tail_lines: z
        .number()
        .optional()
        .describe(
          "If set, return only the last N lines instead of the full file."
        ),
    },
  },
  // @ts-ignore TS2589: cumulative generic depth across registerTool calls hits TS instantiation limit
  async ({ filename, tail_lines }: { filename: string; tail_lines?: number }) => {
    const filePath = path.join(logDir, filename);

    // Security: prevent path traversal
    if (!filePath.startsWith(logDir)) {
      return {
        content: [{ type: "text" as const, text: "Invalid filename." }],
        isError: true,
      };
    }

    const content = readLogContent(filePath, tail_lines);
    return {
      content: [{ type: "text" as const, text: content }],
    };
  }
);

// Tool: search_debug_logs
server.registerTool(
  "search_debug_logs",
  {
    description: "Search across all debug logs for a regex pattern. Returns matching lines with file and line number.",
    inputSchema: {
      pattern: z.string().describe("Regex pattern to search for (case-insensitive)."),
      max_results: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of matching lines to return."),
    },
  },
  // @ts-ignore TS2589: cumulative generic depth across registerTool calls hits TS instantiation limit
  async ({ pattern, max_results }) => {
    try {
      const results = searchLogs(pattern, max_results);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matches found for pattern "${pattern}" in any debug logs.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} match(es):\n\n${results.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid regex pattern: ${err}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: get_debug_errors
server.registerTool(
  "get_debug_errors",
  {
    description: "Extract error and exception lines from debug logs. Useful for quickly finding what went wrong.",
    inputSchema: {
      filename: z
        .string()
        .optional()
        .describe(
          "Specific log file to search. If omitted, searches all log files."
        ),
      context_lines: z
        .number()
        .optional()
        .default(3)
        .describe("Number of lines to include before and after each error for context."),
    },
  },
  // @ts-ignore TS2589: cumulative generic depth across registerTool calls hits TS instantiation limit
  async ({ filename, context_lines }: { filename?: string; context_lines?: number }) => {
    const errorPattern =
      /\b(error|exception|traceback|failed|fatal|critical|panic)\b/i;

    const files = filename
      ? [{ name: filename, path: path.join(logDir, filename) }]
      : getLogFiles();

    const allErrors: string[] = [];

    for (const file of files) {
      if (!fs.existsSync(file.path)) {
        continue;
      }
      const lines = fs.readFileSync(file.path, "utf-8").split("\n");
      const ctx = context_lines ?? 3;

      for (let i = 0; i < lines.length; i++) {
        if (errorPattern.test(lines[i])) {
          const start = Math.max(0, i - ctx);
          const end = Math.min(lines.length - 1, i + ctx);
          const snippet = lines
            .slice(start, end + 1)
            .map((l: string, idx: number) => {
              const lineNum = start + idx + 1;
              const marker = start + idx === i ? ">>>" : "   ";
              return `${marker} ${lineNum}: ${l}`;
            })
            .join("\n");

          allErrors.push(`── ${file.name}:${i + 1} ──\n${snippet}`);

          // Skip ahead past the context window to avoid duplicate reports
          i = end;
        }
      }
    }

    if (allErrors.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No errors or exceptions found in debug logs.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${allErrors.length} error(s):\n\n${allErrors.join("\n\n")}`,
        },
      ],
    };
  }
);

// ── Resources: expose log files as readable resources ─────────────────

server.registerResource(
  "debug-logs-summary",
  "debug://logs/summary",
  { description: "JSON summary of workspace, log directory, and all debug log files." },
  // @ts-ignore TS2589: cumulative generic depth hits TS instantiation limit
  async (uri) => {
    const files = getLogFiles();
    const summary = JSON.stringify(
      {
        workspace: workspacePath,
        logDirectory: logDir,
        files: files.map((f) => ({
          name: f.name,
          sizeKB: +(f.sizeBytes / 1024).toFixed(1),
          modifiedAt: f.modifiedAt,
        })),
      },
      null,
      2
    );

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: summary,
        },
      ],
    };
  }
);

// ── File watcher — notify MCP clients when logs change ────────────────

function setupFileWatcher(): void {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.watch(logDir, (_eventType, filename) => {
    if (filename?.endsWith(".log")) {
      server.server
        .sendResourceUpdated({ uri: "debug://logs/summary" })
        .catch(() => {}); // no-op when no client is subscribed
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────

async function main() {
  setupFileWatcher();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running and listening on stdin/stdout
}

main().catch((err) => {
  console.error("MCP Server failed to start:", err);
  process.exit(1);
});

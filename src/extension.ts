import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { LogManager } from "./logManager";
import { DebugTrackerFactory } from "./debugTracker";
import type { ChildProcess } from "child_process";

let logManager: LogManager;
let outputChannel: vscode.OutputChannel;
let mcpProcess: ChildProcess | undefined;
const warnedIntegratedTerminalConfigs = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Debug Log Capture");
  logManager = new LogManager(outputChannel);

  outputChannel.appendLine("Debug Log Capture activated");

  // ── Register the DAP tracker for ALL debugger types ───────────────

  const trackerFactory = new DebugTrackerFactory(logManager, outputChannel);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", trackerFactory)
  );

  // ── Session lifecycle events ──────────────────────────────────────

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      outputChannel.appendLine(`Session started: ${session.name} [${session.id}]`);
      try {
        const logFile = logManager.startSession(session);
        outputChannel.appendLine(`Logging to: ${logFile}`);
      } catch (err) {
        outputChannel.appendLine(`Failed to start logging: ${err}`);
      }

      if (
        session.configuration?.console === "integratedTerminal" &&
        !session.parentSession
      ) {
        const configName = session.configuration.name ?? session.name;
        if (!warnedIntegratedTerminalConfigs.has(configName)) {
          warnedIntegratedTerminalConfigs.add(configName);
          outputChannel.appendLine(
            `[Warning] Session "${session.name}" uses integratedTerminal — direct process stdout/stderr won't be captured by DAP. Only debugger console output will be logged.`
          );
          vscode.window.showWarningMessage(
            `Debug Log Capture: "${session.name}" uses integratedTerminal. Process output bypasses DAP and won't be captured.`
          );
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      outputChannel.appendLine(`Session ended: ${session.name}`);
      logManager.stopSession(session.id);
    })
  );

  // ── Commands ──────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.openLog", async () => {
      const files = logManager.listLogFiles();
      if (files.length === 0) {
        vscode.window.showInformationMessage(
          "No debug logs yet. Start a debug session first."
        );
        return;
      }

      if (files.length === 1) {
        const doc = await vscode.workspace.openTextDocument(files[0].path);
        await vscode.window.showTextDocument(doc);
        return;
      }

      // Multiple logs — let the user pick
      const pick = await vscode.window.showQuickPick(
        files.map((f) => ({
          label: f.name,
          description: `${(f.sizeBytes / 1024).toFixed(1)} KB`,
          detail: f.path,
        })),
        { placeHolder: "Select a debug log to open" }
      );

      if (pick) {
        const doc = await vscode.workspace.openTextDocument(pick.detail!);
        await vscode.window.showTextDocument(doc);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.cleanLogs", () => {
      logManager.cleanAllLogs();
      vscode.window.showInformationMessage("Debug logs cleaned.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.startMcpServer", () => {
      startMcpServer(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.stopMcpServer", () => {
      stopMcpServer();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.configureClaudeCode", () => {
      configureClaudeCode(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.configureCopilotMcp", () => {
      configureCopilotMcp(context);
    })
  );

  // ── Auto-start MCP server if configured ───────────────────────────

  const config = vscode.workspace.getConfiguration("debugLogCapture");
  if (config.get<boolean>("mcpServer.autoStart", false)) {
    startMcpServer(context);
  }

  outputChannel.appendLine("Ready — debug output will be captured to log files.");
}

// ── MCP Server management ───────────────────────────────────────────

function startMcpServer(context: vscode.ExtensionContext) {
  if (mcpProcess) {
    vscode.window.showInformationMessage("MCP server is already running.");
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const config = vscode.workspace.getConfiguration("debugLogCapture");
  const logDir = config.get<string>("logDirectory", "debug-logs");

  // The compiled MCP server script lives in the extension's out/ folder
  const serverScript = path.join(context.extensionPath, "out", "mcpServer.js");

  const { spawn } = require("child_process") as typeof import("child_process");
  mcpProcess = spawn("node", [serverScript, "--workspace", workspaceRoot, "--log-dir", logDir], {
    stdio: "pipe",
    cwd: workspaceRoot,
  });

  mcpProcess.on("error", (err: Error) => {
    outputChannel.appendLine(`[MCP] Server error: ${err.message}`);
    mcpProcess = undefined;
  });

  mcpProcess.on("exit", (code: number | null) => {
    outputChannel.appendLine(`[MCP] Server exited (code ${code})`);
    mcpProcess = undefined;
  });

  mcpProcess.stderr?.on("data", (data: Buffer) => {
    outputChannel.appendLine(`[MCP] ${data.toString().trimEnd()}`);
  });

  outputChannel.appendLine("[MCP] Server starting…");

  // Verify the process is still alive after 1 s — a crashed process would
  // have already triggered the error/exit handlers above.
  const procRef = mcpProcess;
  setTimeout(() => {
    if (mcpProcess === procRef && mcpProcess.exitCode === null) {
      outputChannel.appendLine("[MCP] Server started and healthy");
      vscode.window.showInformationMessage(
        "MCP server started. Configure Claude Code to connect to it."
      );
    }
  }, 1000);
}

// ── MCP config writers (Claude Code + VS Code/Copilot) ────────────

interface McpConfigTarget {
  displayName: string;              // e.g. "Claude Code" — used in user-facing messages
  settingsRelativePath: string;     // e.g. ".claude/settings.json", ".vscode/mcp.json"
  containerKey: string;             // top-level key that holds servers ("mcpServers" or "servers")
  serverName: string;               // the key under containerKey (always "debug-logs" here)
  buildEntry: (serverScript: string, workspaceRoot: string) => Record<string, unknown>;
  restartHint: string;              // how the user picks up the new config
}

async function writeMcpConfig(
  context: vscode.ExtensionContext,
  target: McpConfigTarget
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const serverScript = path.join(context.extensionPath, "out", "mcpServer.js");
  if (!fs.existsSync(serverScript)) {
    vscode.window.showErrorMessage(
      `MCP server script not found at ${serverScript}. Is the extension installed correctly?`
    );
    return;
  }

  const settingsFile = path.join(workspaceRoot, target.settingsRelativePath);
  const settingsDir = path.dirname(settingsFile);

  // Read existing settings, tolerating missing file or empty content.
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try {
      const raw = fs.readFileSync(settingsFile, "utf-8").trim();
      settings = raw ? JSON.parse(raw) : {};
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
        throw new Error(`${target.settingsRelativePath} root is not a JSON object`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not parse ${settingsFile}: ${err instanceof Error ? err.message : String(err)}. Fix or remove the file and try again.`
      );
      return;
    }
  }

  const container =
    (settings[target.containerKey] as Record<string, unknown> | undefined) ?? {};

  if (container[target.serverName]) {
    const choice = await vscode.window.showWarningMessage(
      `A "${target.serverName}" MCP server is already configured in ${settingsFile}. Overwrite it?`,
      { modal: true },
      "Overwrite",
      "Cancel"
    );
    if (choice !== "Overwrite") {
      return;
    }
  }

  container[target.serverName] = target.buildEntry(serverScript, workspaceRoot);
  settings[target.containerKey] = container;

  try {
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to write ${settingsFile}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  outputChannel.appendLine(
    `[Configure${target.displayName.replace(/\s+/g, "")}] Wrote MCP entry → ${settingsFile}`
  );

  const openAction = `Open ${path.basename(settingsFile)}`;
  const action = await vscode.window.showInformationMessage(
    `${target.displayName} MCP configured in ${path.relative(workspaceRoot, settingsFile)}. ${target.restartHint}`,
    openAction
  );
  if (action === openAction) {
    const doc = await vscode.workspace.openTextDocument(settingsFile);
    await vscode.window.showTextDocument(doc);
  }
}

function configureClaudeCode(context: vscode.ExtensionContext): Promise<void> {
  // Claude Code uses .mcp.json at the workspace root for project-scoped MCP
  // servers (the git-shareable scope). .claude/settings.json is for general
  // settings, not MCP. Both the CLI and the VS Code extension honor this file.
  return writeMcpConfig(context, {
    displayName: "Claude Code",
    settingsRelativePath: ".mcp.json",
    containerKey: "mcpServers",
    serverName: "debug-logs",
    restartHint:
      "Reload the VS Code window (or restart the Claude Code CLI) to pick up the new server.",
    buildEntry: (serverScript, workspaceRoot) => ({
      command: "node",
      args: [serverScript, "--workspace", workspaceRoot],
    }),
  });
}

function configureCopilotMcp(context: vscode.ExtensionContext): Promise<void> {
  return writeMcpConfig(context, {
    displayName: "GitHub Copilot (VS Code)",
    settingsRelativePath: path.join(".vscode", "mcp.json"),
    containerKey: "servers",
    serverName: "debug-logs",
    restartHint: "VS Code should pick up the new server automatically; if not, reload the window.",
    buildEntry: (serverScript, workspaceRoot) => ({
      type: "stdio",
      command: "node",
      args: [serverScript, "--workspace", workspaceRoot],
    }),
  });
}

function stopMcpServer() {
  if (!mcpProcess) {
    vscode.window.showInformationMessage("MCP server is not running.");
    return;
  }

  mcpProcess.kill();
  mcpProcess = undefined;
  outputChannel.appendLine("[MCP] Server stopped");
  vscode.window.showInformationMessage("MCP server stopped.");
}

// ── Deactivation ────────────────────────────────────────────────────

export function deactivate() {
  logManager?.dispose();
  stopMcpServer();
  outputChannel?.appendLine("Debug Log Capture deactivated");
}

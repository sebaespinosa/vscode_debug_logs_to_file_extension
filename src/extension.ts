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

      // Console values that route output to a PTY rather than through DAP. Dart-Code
      // uses "terminal" instead of "integratedTerminal", so accept both.
      const ptyConsoles = new Set(["integratedTerminal", "terminal", "externalTerminal"]);
      const consoleSetting = session.configuration?.console as string | undefined;
      if (
        consoleSetting &&
        ptyConsoles.has(consoleSetting) &&
        !session.parentSession
      ) {
        const configName = session.configuration.name ?? session.name;
        if (!warnedIntegratedTerminalConfigs.has(configName)) {
          warnedIntegratedTerminalConfigs.add(configName);
          outputChannel.appendLine(
            `[Warning] Session "${session.name}" uses console="${consoleSetting}" — direct process stdout/stderr may bypass DAP and not be captured.`
          );
          vscode.window.showWarningMessage(
            `Debug Log Capture: "${session.name}" uses console="${consoleSetting}". Process output may bypass DAP and not be fully captured.`
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

  context.subscriptions.push(
    vscode.commands.registerCommand("debugLogCapture.checkLaunchConfig", () => {
      checkLaunchConfig();
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

// ── Launch configuration validator ─────────────────────────────────

type CaptureVerdict =
  | { severity: "ok"; summary: string; detail: string }
  | { severity: "warn"; summary: string; detail: string; recommendation: string }
  | { severity: "bad"; summary: string; detail: string; recommendation: string };

function verdictForConfig(cfg: Record<string, unknown>): CaptureVerdict {
  const rawConsole = cfg.console as string | undefined;
  const type = (cfg.type as string | undefined) ?? "unknown";
  const request = (cfg.request as string | undefined) ?? "unknown";
  const flutterMode = cfg.flutterMode as string | undefined;
  const isPython = type === "debugpy" || type === "python";
  const isDart = type === "dart" || type === "flutter";

  // Dart-Code uses different vocabulary than the rest of the ecosystem. Normalize
  // here so the verdict tree below stays simple.
  let consoleSetting = rawConsole;
  if (isDart) {
    if (rawConsole === "debugConsole") {
      consoleSetting = "internalConsole";
    } else if (rawConsole === "terminal") {
      consoleSetting = "integratedTerminal";
    }
    // Default for Dart `request: launch` is `debugConsole` (= internalConsole).
    if (rawConsole === undefined && request === "launch") {
      consoleSetting = "internalConsole";
    }
  }

  // Flutter release mode strips VM debugging — useful capture is limited even with
  // debugConsole. Append this caveat to the relevant verdict's detail.
  const flutterReleaseCaveat =
    isDart && flutterMode === "release"
      ? ` Note: flutterMode="release" disables Dart VM debugging, so the captured content will be limited to build/launch output regardless of console setting.`
      : "";

  if (consoleSetting === "internalConsole") {
    return {
      severity: "ok",
      summary:
        flutterMode === "release"
          ? "Full capture available, but limited by release mode"
          : "Full capture expected",
      detail: `Output flows through DAP to the extension.${flutterReleaseCaveat}`,
    };
  }
  if (consoleSetting === "externalTerminal") {
    return {
      severity: "bad",
      summary: "No capture expected",
      detail: `"externalTerminal" opens a separate OS terminal; output bypasses DAP entirely.${flutterReleaseCaveat}`,
      recommendation: isDart
        ? `Change "console" to "debugConsole" (or omit the field — that's the default for Dart launch configs).`
        : `Change "console" to "internalConsole".`,
    };
  }
  if (consoleSetting === "integratedTerminal") {
    if (isPython) {
      return {
        severity: "warn",
        summary: "Partial capture expected",
        detail: `debugpy's Python-level output redirection forwards most stdout/stderr through DAP, but a few early lines from the parent process (printed before the hooks install) may be missing. ANSI escape sequences are preserved verbatim.`,
        recommendation: `For full capture, change "console" to "internalConsole".`,
      };
    }
    if (isDart) {
      return {
        severity: "warn",
        summary: "Partial capture expected",
        detail: `"terminal" routes the app's stdout/stderr through a PTY. The Dart-Code adapter still emits structured DAP output events (stack traces, hot-reload notifications), but application print() output may not reach DAP.${flutterReleaseCaveat}`,
        recommendation: `For full capture, change "console" to "debugConsole" (or omit the field — that's the default for Dart launch configs).`,
      };
    }
    return {
      severity: "bad",
      summary: "No capture expected",
      detail: `"integratedTerminal" routes output directly to a terminal PTY. For non-Python, non-Dart debuggers this bypasses DAP entirely.`,
      recommendation: `Change "console" to "internalConsole".`,
    };
  }
  // console not specified — only reached for non-Dart debuggers (Dart's default
  // was already normalized above).
  return {
    severity: "warn",
    summary: "Console not specified",
    detail: `The debugger (${type}) will use its default console behavior, which varies. For reliable capture, set this explicitly.`,
    recommendation: `Add "console": "internalConsole" to this configuration.`,
  };
}

function iconFor(severity: CaptureVerdict["severity"]): string {
  return severity === "ok" ? "✅" : severity === "warn" ? "⚠️" : "❌";
}

async function checkLaunchConfig(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const launchConfig = vscode.workspace.getConfiguration("launch", folder.uri);
  const configurations =
    (launchConfig.get<Record<string, unknown>[]>("configurations") ?? []).filter(
      (c) => c && typeof c === "object"
    );
  const compounds =
    (launchConfig.get<Record<string, unknown>[]>("compounds") ?? []).filter(
      (c) => c && typeof c === "object"
    );

  if (configurations.length === 0 && compounds.length === 0) {
    vscode.window.showInformationMessage(
      "No launch configurations found in this workspace. Create a .vscode/launch.json to get started."
    );
    return;
  }

  const verdicts = configurations.map((cfg) => ({ cfg, verdict: verdictForConfig(cfg) }));
  const counts = {
    ok: verdicts.filter((v) => v.verdict.severity === "ok").length,
    warn: verdicts.filter((v) => v.verdict.severity === "warn").length,
    bad: verdicts.filter((v) => v.verdict.severity === "bad").length,
  };

  const lines: string[] = [];
  lines.push(`# Launch Configuration Check`);
  lines.push("");
  lines.push(`**Workspace**: \`${folder.uri.fsPath}\``);
  lines.push("");
  lines.push(
    `**Summary**: ${verdicts.length} configuration(s) checked — ${counts.ok} optimal, ${counts.warn} warning, ${counts.bad} likely broken.`
  );
  lines.push("");
  lines.push(`---`);
  lines.push("");

  for (const { cfg, verdict } of verdicts) {
    const name = (cfg.name as string | undefined) ?? "(unnamed)";
    const type = (cfg.type as string | undefined) ?? "unknown";
    const request = (cfg.request as string | undefined) ?? "unknown";
    const consoleSetting = (cfg.console as string | undefined) ?? "(not set)";

    lines.push(`## ${iconFor(verdict.severity)} ${name}`);
    lines.push("");
    lines.push(`- **Type**: \`${type}\``);
    lines.push(`- **Request**: \`${request}\``);
    lines.push(`- **Console**: \`${consoleSetting}\``);
    lines.push(`- **Status**: ${verdict.summary}`);
    lines.push(`- **Detail**: ${verdict.detail}`);
    if (verdict.severity !== "ok") {
      lines.push(`- **Recommendation**: ${verdict.recommendation}`);
    }
    lines.push("");
  }

  if (compounds.length > 0) {
    lines.push(`---`);
    lines.push("");
    lines.push(`## Compound configurations`);
    lines.push("");
    const verdictByName = new Map(
      verdicts.map((v) => [v.cfg.name as string, v.verdict])
    );
    for (const compound of compounds) {
      const cname = (compound.name as string | undefined) ?? "(unnamed)";
      const refs = (compound.configurations as string[] | undefined) ?? [];
      lines.push(`- **${cname}** references:`);
      for (const ref of refs) {
        const v = verdictByName.get(ref);
        const icon = v ? iconFor(v.severity) : "❓";
        lines.push(`  - ${icon} \`${ref}\`${v ? ` — ${v.summary}` : " — not found in configurations"}`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push("");
  lines.push(
    `See the [README](https://github.com/sebaespinosa/vscode_debug_logs_to_file_extension#recommended-launch-configuration) for the full capture matrix and example configs.`
  );

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: lines.join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: true });
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

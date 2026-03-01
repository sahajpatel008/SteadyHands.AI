import { app, BrowserWindow, ipcMain, session } from "electron";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getPublicConfig } from "./config";
import {
  inferIntent,
  isAtCompletionPoint,
  isGoalAchieved,
  isPageRelevantToGoal,
  planAction,
  respondConversationally,
  summarizePage,
  safetySupervisor,
  semanticInterpreter,
} from "./llm";
import { logMain } from "../../shared/logger";
import { McpClientManager } from "./mcp";
import type { McpToolCall, PageObservation, PlanActionInput } from "../../shared/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let mcpManager: McpClientManager | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
      webSecurity: false,
    },
    title: "SteadyHands.AI",
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function setupIpcHandlers() {
  ipcMain.handle("config:getPublic", () => {
    logMain("ipc", "config:getPublic called");
    return getPublicConfig();
  });

  ipcMain.handle("agent:getSystemContext", () => {
    const cwd = process.cwd();
    const candidates = [
      path.join(cwd, "AGENTS.md"),
      path.join(cwd, ".codex", "AGENTS.md"),
    ];
    let agentsInstructions = "";
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        agentsInstructions = fs.readFileSync(candidate, "utf8");
        break;
      } catch {
        // keep trying next candidate
      }
    }
    return {
      cwd,
      agentsInstructions: agentsInstructions.slice(0, 16000),
      platform: process.platform,
      nodeVersion: process.version,
    };
  });

  ipcMain.handle("llm:summarizePage", async (_, payload: PageObservation) => {
    logMain("ipc", "llm:summarizePage called", { url: payload.url, elements: payload.elements?.length });
    const result = await summarizePage(payload);
    logMain("ipc", "llm:summarizePage done", { summaryLen: result.summary?.length });
    return result;
  });

  ipcMain.handle("llm:inferIntent", async (_, rawGoal: string) => {
    logMain("ipc", "llm:inferIntent called", { rawGoalLen: rawGoal?.length });
    const result = await inferIntent(rawGoal);
    logMain("ipc", "llm:inferIntent done");
    return result;
  });

  ipcMain.handle("llm:respondConversationally", async (_, userMessage: string) => {
    logMain("ipc", "llm:respondConversationally called", { userMessageLen: userMessage?.length });
    const result = await respondConversationally(userMessage);
    logMain("ipc", "llm:respondConversationally done");
    return result;
  });

  ipcMain.handle(
    "llm:semanticInterpreter",
    async (
      _,
      payload: {
        observation: PageObservation;
        userGoal: string;
        searchQuery?: string;
      },
    ) => {
      logMain("ipc", "llm:semanticInterpreter called", {
        url: payload.observation?.url,
        searchQuery: payload.searchQuery?.slice(0, 40),
      });
      const result = await semanticInterpreter(
        payload.observation,
        payload.userGoal,
        { searchQuery: payload.searchQuery },
      );
      logMain("ipc", "llm:semanticInterpreter done", { choices: result.choices?.length });
      return result;
    },
  );

  ipcMain.handle(
    "llm:safetySupervisor",
    async (_, payload: { userGoal: string; action: import("../../shared/types").BrowserAction; context: { url: string; currentStep?: string } }) => {
      logMain("ipc", "llm:safetySupervisor called");
      return safetySupervisor(payload.userGoal, payload.action, payload.context);
    },
  );

  ipcMain.handle(
    "llm:planAction",
    async (_, payload: PlanActionInput) => {
      logMain("ipc", "llm:planAction called", {
        goal: payload.goal?.slice(0, 80),
        url: payload.observation?.url,
        timelineLen: payload.timeline?.length,
        availableActions: payload.availableActions?.length ?? 0,
        availableMcpTools: payload.availableMcpTools?.length ?? 0,
      });
      const result = await planAction(payload);
      logMain("ipc", "llm:planAction done", {
        done: result.done,
        askQuestion: !!result.askQuestion,
        selectedChoiceIndex:
          !result.done ? result.selectedChoiceIndex : undefined,
        action: result.done ? undefined : (result as { action?: unknown }).action,
      });
      return result;
    },
  );

  ipcMain.handle("mcp:listTools", async () => {
    logMain("ipc", "mcp:listTools called");
    if (!mcpManager) {
      logMain("ipc", "mcp:listTools skipped: manager unavailable");
      return [];
    }
    const tools = await mcpManager.listTools();
    logMain("ipc", "mcp:listTools done", { tools: tools.length });
    return tools;
  });

  ipcMain.handle("mcp:callTool", async (_, payload: McpToolCall) => {
    logMain("ipc", "mcp:callTool called", {
      server: payload.server,
      name: payload.name,
    });
    if (!mcpManager) {
      throw new Error("MCP manager not initialized.");
    }
    const result = await mcpManager.callTool(payload);
    logMain("ipc", "mcp:callTool done", {
      ok: result.ok,
      server: result.server,
      name: result.name,
    });
    return result;
  });

  ipcMain.handle(
    "llm:isPageRelevantToGoal",
    async (
      _,
      payload: {
        observation: PageObservation;
        goal: string;
        planSteps?: string[];
        planStepIndex?: number;
      },
    ) => {
      return isPageRelevantToGoal(payload.observation, payload.goal, {
        planSteps: payload.planSteps,
        planStepIndex: payload.planStepIndex,
      });
    },
  );

  ipcMain.handle("llm:isGoalAchieved", async (_, payload: { observation: PageObservation; goal: string }) => {
    return isGoalAchieved(payload.observation, payload.goal);
  });

  ipcMain.handle("tts:speak", async (_, text: string): Promise<string> => {
    const config = getConfig();
    if (!config.elevenLabsApiKey) {
      throw new Error("ElevenLabs API key (ELEVEN_LABS_API_KEY) is not configured in .env");
    }
    const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
    const body = JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    });
    return new Promise<string>((resolve, reject) => {
      const options = {
        hostname: "api.elevenlabs.io",
        path: `/v1/text-to-speech/${VOICE_ID}`,
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "xi-api-key": config.elevenLabsApiKey!,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`ElevenLabs error ${res.statusCode}: ${buffer.toString()}`));
          } else {
            resolve(buffer.toString("base64"));
          }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  });

  ipcMain.handle(
    "llm:isAtCompletionPoint",
    async (_, payload: { observation: PageObservation; completionPoint: string }) => {
      return isAtCompletionPoint(payload.observation, payload.completionPoint);
    },
  );
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') {
      return true;
    }
    return false;
  });

  logMain("init", "App ready");
  const config = getConfig();
  logMain("config", "Loaded", {
    plannerModel: config.plannerModel,
    fastPlannerModel: config.fastPlannerModel,
    summarizerModel: config.summarizerModel,
    defaultAgentMode: config.defaultAgentMode,
    maxSteps: config.maxSteps,
    confidenceThreshold: config.confidenceThreshold,
    turboMode: config.turboMode,
    mcpServers: Object.keys(config.mcpServers),
  });
  mcpManager = new McpClientManager(config.mcpServers);

  setupIpcHandlers();
  logMain("init", "IPC handlers registered");

  // Intercept new-window requests from webview (e.g. target="_blank" links)
  // and load them in the same webview instead of opening a new window
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler((details) => {
        const url = details.url;
        if (url && url !== "about:blank") {
          contents.loadURL(url);
        }
        return { action: "deny" };
      });
    }
  });

  createWindow();
  logMain("init", "Window created");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (mcpManager) {
    void mcpManager.closeAll();
  }
});

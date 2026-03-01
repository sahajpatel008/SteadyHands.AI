import express from 'express';
import cors from 'cors';
import path from 'path';
import { Stagehand, CustomOpenAIClient } from '@browserbasehq/stagehand';
import { z } from 'zod';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Self-hosted Qwen3 LLM on AMD Developer Cloud
const AMD_LLM_BASE_URL = 'http://165.245.139.104:443/v1';
const AMD_LLM_MODEL = 'Qwen3-30B-A3B';

const LOG_FILE = path.join(__dirname, 'backend.log');
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

console.log = (...args) => {
  logToFile(args.map(String).join(' '));
  process.stdout.write(args.map(String).join(' ') + '\n');
};
console.error = (...args) => {
  logToFile('[ERROR] ' + args.map(String).join(' '));
  process.stderr.write(args.map(String).join(' ') + '\n');
};

function createLLMClient() {
  const client = new OpenAI({
    baseURL: AMD_LLM_BASE_URL,
    apiKey: process.env.AMD_LLM_API_KEY,
  });
  return new CustomOpenAIClient({
    modelName: AMD_LLM_MODEL,
    client: client as any,
  });
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve the mock frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3001;

// Store active browser sessions
const sessions: Map<string, { stagehand: Stagehand; url: string }> = new Map();

// ─── Quick test endpoint (no session management) ───
app.post('/api/test', async (req, res) => {
  const { targetUrl, action } = req.body;

  if (!targetUrl || !action) {
    return res.status(400).json({ error: "Missing targetUrl or action" });
  }

  console.log(`\n🧪 TEST — url: ${targetUrl}`);
  console.log(`🧪 TEST — action: "${action}"`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { headless: false },
    llmClient: createLLMClient(),
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error('No browser page available');

    await page.goto(targetUrl);
    console.log("✅ Page loaded");

    await stagehand.act(action);
    console.log("✅ Action performed");

    const result = await stagehand.extract(
      `Do not think or reason. Return ONLY valid JSON. Describe exactly what happened on the page after the action. Be specific about what was clicked, typed, or changed.`,
      z.object({
        description: z.string().describe("What happened on the page"),
        currentUrl: z.string().describe("The current URL of the page"),
        suggestions: z.array(z.string()).describe("2-3 possible next actions"),
      })
    );

    console.log("✅ Extraction done:", result);
    res.json({ success: true, ...result });

  } catch (error: any) {
    console.error("❌ Test failed:", error);
    res.status(500).json({ success: false, error: error.message ?? String(error) });
  } finally {
    await stagehand.close();
    console.log("🧪 Browser closed\n");
  }
});

// Start a new session - opens browser and navigates to URL
app.post('/api/session/start', async (req, res) => {
  const { targetUrl } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing targetUrl" });
  }

  console.log(`🚀 Opening browser for ${targetUrl}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      headless: false,
    },
    llmClient: createLLMClient(),
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error('No browser page available');

    await page.goto(targetUrl);

    const sessionId = randomUUID();
    sessions.set(sessionId, { stagehand, url: targetUrl });

    console.log(`✅ Session ${sessionId} created`);
    res.json({ sessionId, message: "Browser opened successfully" });

  } catch (error) {
    console.error("❌ Error starting session:", error);
    await stagehand.close();
    res.status(500).json({ error: "Failed to open browser" });
  }
});

// Perform an action on an existing session
app.post('/api/session/act', async (req, res) => {
  const { sessionId, userGoal } = req.body;

  if (!sessionId || !userGoal) {
    return res.status(400).json({ error: "Missing sessionId or userGoal" });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found. Browser may have been closed." });
  }

  console.log(`🤖 Acting on: "${userGoal}"`);

  try {
    await session.stagehand.act(userGoal);
    console.log("✅ Action performed");

    console.log("🔍 Extracting what happened...");
    const result = await session.stagehand.extract(
      `Do not think or reason. Return ONLY valid JSON. Describe what just happened on the page after the action. Also suggest 2-3 possible next actions the user might want to take.`,
      z.object({
        description: z.string().describe("A simple, friendly description of what happened"),
        suggestions: z.array(z.string()).describe("2-3 suggested next actions")
      })
    );

    console.log("✅ Extraction done:", result);
    res.json(result);

  } catch (error) {
    console.error("❌ Error during action:", error);
    res.status(500).json({ error: "Failed to complete the action. Try again or rephrase." });
  }
});

// Close a session
app.post('/api/session/close', async (req, res) => {
  const { sessionId } = req.body;

  const session = sessions.get(sessionId);
  if (session) {
    await session.stagehand.close();
    sessions.delete(sessionId);
    console.log(`👋 Session ${sessionId} closed`);
  }

  res.json({ message: "Session closed" });
});

app.listen(PORT, () => {
  console.log(`🤖 Nav-Mate API running on http://localhost:${PORT}`);
});
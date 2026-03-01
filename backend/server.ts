import express from 'express';
import cors from 'cors';
import path from 'path';
import { Stagehand, CustomOpenAIClient } from '@browserbasehq/stagehand';
import { z } from 'zod';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import fs from 'fs';
import twilio from 'twilio';

// Load environment variables
dotenv.config();

// ─── Feature flags ───
const TWILIO_ENABLED = 'false';
// const TWILIO_ENABLED = process.env.TWILIO_ENABLED !== 'false';
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

// ─── Session types ───
type HistoryEntry = { role: 'user' | 'agent'; content: string };

type Session = {
  stagehand: Stagehand;
  url: string;
  goal: string | null;
  history: HistoryEntry[];
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

// ─── Raw OpenAI client (for planner — bypasses Stagehand) ───
function createRawClient() {
  return new OpenAI({
    baseURL: AMD_LLM_BASE_URL,
    apiKey: process.env.AMD_LLM_API_KEY,
  });
}

// ─── Planner: decides if goal is actionable or needs clarification ───
async function callPlanner(
  userMessage: string,
  goal: string | null,
  history: HistoryEntry[]
): Promise<{ actionable: boolean; sub_step: string | null; clarification_question: string | null }> {
  const openai = createRawClient();
  const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n') || '(none)';

  const systemPrompt = `You are a browser automation planner. Given a user goal and conversation history, decide if the goal is specific enough to act on immediately, or if you need more info.

Return ONLY valid JSON — no thinking, no explanation, no markdown:
{
  "actionable": true | false,
  "sub_step": "single concrete browser action if actionable, else null",
  "clarification_question": "what to ask the user if not actionable, else null"
}

Rules:
- If the goal is specific enough, set actionable: true and provide a single sub_step (e.g. "Type 'Ethiopian food' into the search bar and press Enter").
- If the goal is vague or missing required info, set actionable: false and provide a clarification_question.
- sub_step must be ONE concrete browser action.`;

  const response = await openai.chat.completions.create({
    model: AMD_LLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Overall goal: ${goal ?? userMessage}\nConversation so far:\n${historyText}\nLatest message: ${userMessage}` },
    ],
    temperature: 0.1,
  });

  const raw = response.choices[0].message.content ?? '{}';
  // Strip <think>...</think> blocks Qwen3 might emit
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Extract first JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : { actionable: true, sub_step: userMessage, clarification_question: null };
}

// ─── Twilio: confirm completed goal ───
async function triggerConfirmationCall(goalSummary: string) {
  if (!TWILIO_ENABLED) {
    console.log('🔇 Twilio is disabled (TWILIO_ENABLED=false) — skipping confirmation call');
    return;
  }
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const to = process.env.TWILIO_TO_NUMBER;

    if (!accountSid || !authToken || !from || !to) {
      console.log('⚠️ Twilio env vars not set — skipping confirmation call');
      return;
    }

    const client = twilio(accountSid, authToken);
    await client.calls.create({
      twiml: `<Response><Say>Your task has been completed. ${goalSummary}</Say></Response>`,
      to,
      from,
    });
    console.log('📞 Twilio confirmation call triggered');
  } catch (err) {
    console.error('❌ Twilio call failed:', err);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve the mock frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3001;

// Store active browser sessions
const sessions: Map<string, Session> = new Map();

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
    sessions.set(sessionId, { stagehand, url: targetUrl, goal: null, history: [] });

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

  // Save top-level goal on first message
  if (!session.goal) {
    session.goal = userGoal;
  }

  // Append user message to history
  session.history.push({ role: 'user', content: userGoal });

  console.log(`🧠 Planner evaluating: "${userGoal}"`);

  try {
    // ─── PLANNER ───
    const plan = await callPlanner(userGoal, session.goal, session.history);
    console.log('🧠 Planner result:', JSON.stringify(plan));

    if (!plan.actionable) {
      const question = plan.clarification_question ?? 'Could you give me more details?';
      session.history.push({ role: 'agent', content: `[clarification] ${question}` });
      return res.json({ status: 'needs_clarification', question });
    }

    const subStep = plan.sub_step ?? userGoal;
    console.log(`🤖 Acting on sub-step: "${subStep}"`);

    // ─── STAGEHAND ACT ───
    await session.stagehand.act(subStep);
    console.log('✅ Action performed');

    // ─── EXTRACT ───
    console.log('🔍 Extracting what happened...');
    const result = await session.stagehand.extract(
      `Do not think or reason. Return ONLY valid JSON. Describe what just happened on the page after the action.`,
      z.object({
        description: z.string().describe('A simple, friendly description of what happened'),
        is_goal_complete: z.boolean().describe('True if the overall user goal has been fully completed'),
        needs_user_input: z.boolean().describe('True if the agent needs more info from the user to continue'),
        clarification_question: z.string().optional().describe('What to ask the user if needs_user_input is true'),
        extracted_options: z.array(z.object({
          name: z.string(),
          description: z.string().optional(),
          rating: z.string().optional(),
          price: z.string().optional(),
        })).optional().describe('Selectable options shown on screen (restaurants, products, search results, etc.)'),
        suggestions: z.array(z.string()).describe('2-3 suggested next actions'),
      })
    );

    console.log('✅ Extraction done:', result);

    // Append agent result to history
    session.history.push({ role: 'agent', content: result.description });

    // Trigger Twilio if goal is complete
    if (result.is_goal_complete) {
      await triggerConfirmationCall(session.goal ?? result.description);
    }

    // If extraction says we need user input, return clarification
    if (result.needs_user_input && result.clarification_question) {
      session.history.push({ role: 'agent', content: `[clarification] ${result.clarification_question}` });
      return res.json({ status: 'needs_clarification', question: result.clarification_question });
    }

    return res.json({
      status: 'action_complete',
      description: result.description,
      is_goal_complete: result.is_goal_complete,
      extracted_options: result.extracted_options,
      suggestions: result.suggestions,
    });

  } catch (error) {
    console.error('❌ Error during action:', error);
    res.status(500).json({ error: 'Failed to complete the action. Try again or rephrase.' });
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
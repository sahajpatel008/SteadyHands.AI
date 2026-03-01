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

// ─── ReAct agent constants ───
const MAX_REACT_STEPS = 5;

// ─── Page context schema (snapshotted before each reasoning step) ───
const PageContextSchema = z.object({
  page_title: z.string(),
  current_url: z.string(),
  page_summary: z.string().describe('1-2 sentence summary of what this page is and what it offers'),
  has_search_bar: z.boolean(),
  has_login_wall: z.boolean().describe('True if the page requires login before proceeding'),
  has_download_link: z.boolean().describe('True if at least one downloadable file link is visible'),
  interactive_elements: z.array(z.object({
    type: z.enum(['button', 'link', 'input', 'dropdown', 'tab']),
    text: z.string(),
    purpose: z.string().describe('What this element does in one phrase'),
  })).describe('Up to 15 most relevant interactive elements on the page'),
  visible_results: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    url: z.string().optional(),
    file_type: z.string().optional().describe('e.g. PDF, DOCX, HTML'),
    rating: z.string().optional(),
    price: z.string().optional(),
  })).optional().describe('Visible list items, search results, products, documents, or download links'),
});
type PageContext = z.infer<typeof PageContextSchema>;

type ExtractedOption = {
  name: string;
  description?: string;
  url?: string;
  file_type?: string;
  rating?: string;
  price?: string;
};

type ReActStep = {
  thought: string;
  action_type: 'act' | 'surface_options' | 'ask_human';
  action_instruction: string | null;
  options: ExtractedOption[] | null;
  question: string | null;
};

// ─── DOM snapshot via Stagehand extract ───
async function getPageContext(stagehand: Stagehand): Promise<PageContext> {
  return await stagehand.extract(
    `Do not think or reason. Return ONLY valid JSON. Snapshot the current page: title, URL, 1-2 sentence summary, whether it has a search bar, login wall, download links, the up-to-15 most relevant interactive elements, and any visible results or list items relevant to a user task.`,
    PageContextSchema
  );
}

// ─── ReAct step: reason over DOM context and decide next action ───
async function callReActStep(
  goal: string,
  history: HistoryEntry[],
  pageContext: PageContext,
  stepNum: number
): Promise<ReActStep> {
  const openai = createRawClient();
  const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n') || '(none)';
  const stepsRemaining = MAX_REACT_STEPS - stepNum;

  const systemPrompt = `You are a DOM-aware browser automation agent. You see the current page state and must decide the single best next action toward the user's goal.

Return ONLY valid JSON — no thinking, no explanation, no markdown:
{
  "thought": "one sentence: what you see and why you chose this action",
  "action_type": "act" | "surface_options" | "ask_human",
  "action_instruction": "precise Stagehand browser instruction, or null",
  "options": [{"name": "", "description": "", "url": "", "file_type": "", "rating": "", "price": ""}] or null,
  "question": "question for the user, or null"
}

Decision rules (strict priority order):
1. SURFACE_OPTIONS — visible_results on the page are directly relevant to the goal (search results, PDF links, product listings, download buttons). Return them immediately. Do NOT keep navigating when results are already visible.
2. ACT — there is a clearly useful interactive element (search bar, navigation link, relevant button). Generate ONE precise Stagehand instruction e.g. "Type '1040-SR' into the search bar and press Enter" or "Click the link that says 'Forms & Publications'".
3. ASK_HUMAN — ONLY if has_login_wall is true, or there are zero relevant interactive elements. NEVER ask just because the goal is vague — try to act first.

${stepsRemaining === 1 ? 'IMPORTANT: This is your LAST step. You MUST choose surface_options or ask_human — do NOT choose act.' : ''}

Field rules:
- act: set action_instruction, set options=null, set question=null
- surface_options: set options from visible_results (include url and file_type when available), set action_instruction=null, set question=null
- ask_human: set question, set action_instruction=null, set options=null`;

  const userContent = `Goal: ${goal}

Current page:
- Title: ${pageContext.page_title}
- URL: ${pageContext.current_url}
- Summary: ${pageContext.page_summary}
- has_search_bar: ${pageContext.has_search_bar}
- has_login_wall: ${pageContext.has_login_wall}
- has_download_link: ${pageContext.has_download_link}
- Interactive elements: ${JSON.stringify(pageContext.interactive_elements)}
- Visible results: ${JSON.stringify(pageContext.visible_results ?? [])}

Conversation so far:
${historyText}

Step ${stepNum + 1} of ${MAX_REACT_STEPS}. Decide your next action.`;

  const response = await openai.chat.completions.create({
    model: AMD_LLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
  });

  const raw = response.choices[0].message.content ?? '{}';
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('❌ callReActStep: no JSON found in response:', raw.slice(0, 200));
    return { thought: 'Parse error', action_type: 'ask_human', action_instruction: null, options: null, question: 'I had trouble reading the page. Could you describe what you see?' };
  }
  return JSON.parse(match[0]) as ReActStep;
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

  console.log(`\n🎯 Goal: "${session.goal}"`);
  console.log(`💬 User: "${userGoal}"`);

  try {
    // ─── ReAct LOOP (up to MAX_REACT_STEPS iterations) ───
    type ThinkingStep = { step: number; thought: string; action_type: string; action_instruction: string | null };
    const thinkingSteps: ThinkingStep[] = [];

    for (let stepNum = 0; stepNum < MAX_REACT_STEPS; stepNum++) {

      // 1. Snapshot the live page via Stagehand extract
      console.log(`\n🔍 Getting page context [step ${stepNum + 1}/${MAX_REACT_STEPS}]...`);
      const pageContext = await getPageContext(session.stagehand);
      console.log(`📄 Page: "${pageContext.page_title}" | ${pageContext.current_url}`);
      console.log(`📊 search=${pageContext.has_search_bar} login_wall=${pageContext.has_login_wall} download=${pageContext.has_download_link} results=${pageContext.visible_results?.length ?? 0}`);

      // 2. Ask the ReAct agent what to do next
      const step = await callReActStep(session.goal ?? userGoal, session.history, pageContext, stepNum);
      console.log(`🧠 Thought [${stepNum + 1}]: ${step.thought}`);
      console.log(`🎬 Decision: ${step.action_type}`);

      // Accumulate for frontend display
      thinkingSteps.push({
        step: stepNum + 1,
        thought: step.thought,
        action_type: step.action_type,
        action_instruction: step.action_instruction ?? null,
      });

      // 3. Branch on the agent's decision

      if (step.action_type === 'ask_human') {
        const question = step.question ?? 'Could you give me more context?';
        session.history.push({ role: 'agent', content: `[clarification] ${question}` });
        return res.json({ status: 'needs_clarification', question, thinking_steps: thinkingSteps });
      }

      if (step.action_type === 'surface_options') {
        const options: ExtractedOption[] = step.options ?? pageContext.visible_results ?? [];
        const description = `Found ${options.length} result${options.length !== 1 ? 's' : ''} for your goal.`;
        session.history.push({ role: 'agent', content: description });
        const isComplete = options.length > 0 && (
          pageContext.has_download_link ||
          options.some(o => o.file_type?.toLowerCase().includes('pdf') || !!o.url)
        );
        if (isComplete) await triggerConfirmationCall(session.goal ?? description);
        console.log(`🎯 Surfacing ${options.length} options (is_goal_complete=${isComplete})`);
        return res.json({
          status: 'action_complete',
          description,
          is_goal_complete: isComplete,
          extracted_options: options,
          thinking_steps: thinkingSteps,
          suggestions: [
            'Click one of the options above to continue',
            'Ask me to refine the search',
            'Ask me to navigate to a different section',
          ],
        });
      }

      // action_type === 'act'
      const instruction = step.action_instruction ?? '';
      console.log(`🤖 Acting [${stepNum + 1}]: "${instruction}"`);
      await session.stagehand.act(instruction);
      console.log(`✅ Action complete`);
      session.history.push({ role: 'agent', content: `[step ${stepNum + 1}] ${instruction}` });
      // continue to next iteration
    }

    // ─── Max steps exhausted — surface final page state ───
    console.log(`⚠️ Max steps (${MAX_REACT_STEPS}) reached — surfacing current page state`);
    const finalContext = await getPageContext(session.stagehand);
    const finalOptions: ExtractedOption[] = finalContext.visible_results ?? [];
    session.history.push({ role: 'agent', content: `Reached ${MAX_REACT_STEPS} steps. Current page: ${finalContext.page_title}` });
    return res.json({
      status: 'action_complete',
      description: `I've taken ${MAX_REACT_STEPS} steps. Here's what I found on "${finalContext.page_title}".`,
      is_goal_complete: false,
      extracted_options: finalOptions,
      thinking_steps: thinkingSteps,
      suggestions: [
        'Tell me to keep going from here',
        'Describe what you want me to click',
        'Ask me to search for something specific',
      ],
    });

  } catch (error) {
    console.error('❌ Error during ReAct loop:', error);
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
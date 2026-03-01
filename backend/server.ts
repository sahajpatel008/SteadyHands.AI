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
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { createToolCallingAgent, AgentExecutor } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

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

// ─── DOM snapshot via Stagehand extract ───
async function getPageContext(stagehand: Stagehand): Promise<PageContext> {
  return await stagehand.extract(
    `Do not think or reason. Return ONLY valid JSON. Snapshot the current page: title, URL, 1-2 sentence summary, whether it has a search bar, login wall, download links, the up-to-15 most relevant interactive elements, and any visible results or list items relevant to a user task.`,
    PageContextSchema
  );
}

// ─── LangChain LLM (tool-calling, same AMD endpoint) ───
function createLangChainLLM() {
  return new ChatOpenAI({
    modelName: AMD_LLM_MODEL,
    temperature: 0.1,
    configuration: {
      baseURL: AMD_LLM_BASE_URL,
      apiKey: process.env.AMD_LLM_API_KEY,
    },
  });
}

// ─── Build per-request LangChain tools bound to the live Stagehand instance ───
type FinishPayload = {
  description: string;
  is_goal_complete: boolean;
  options?: ExtractedOption[];
  question_for_user?: string;
};

function buildAgentTools(stagehand: Stagehand, onFinish: (payload: FinishPayload) => void) {
  const observePage = tool(
    async () => {
      console.log('🔍 [tool] observe_page called');
      const ctx = await getPageContext(stagehand);
      console.log(`📄 [tool] Page: "${ctx.page_title}" | ${ctx.current_url}`);
      return JSON.stringify(ctx);
    },
    {
      name: 'observe_page',
      description:
        'Snapshot the current browser page. Returns title, URL, a short summary, whether it has a search bar / login wall / download links, ' +
        'up to 15 interactive elements, and visible results. ALWAYS call this first before deciding what action to take.',
      schema: z.object({}),
    }
  );

  const browserAct = tool(
    async ({ instruction }: { instruction: string }) => {
      console.log(`🤖 [tool] browser_act: "${instruction}"`);
      await stagehand.act(instruction);
      console.log('✅ [tool] browser_act complete');
      return `Action completed: ${instruction}`;
    },
    {
      name: 'browser_act',
      description:
        'Execute a single precise browser action (click, type, scroll, navigate). ' +
        'Example instructions: "Type \'1040-SR\' into the search bar and press Enter", ' +
        '"Click the link that says \'Forms & Publications\'". ' +
        'After acting, always call observe_page to see what changed.',
      schema: z.object({
        instruction: z.string().describe('The precise browser action to perform'),
      }),
    }
  );

  const finish = tool(
    async (payload: FinishPayload) => {
      console.log('🎯 [tool] finish called:', JSON.stringify(payload).slice(0, 120));
      onFinish(payload);
      return 'Result captured.';
    },
    {
      name: 'finish',
      description:
        'Call this when you have a final answer for the user — either you found relevant options/results, ' +
        'completed the goal, or need to ask the user something. ' +
        'ALWAYS end by calling finish.',
      schema: z.object({
        description: z.string().describe('A plain-English summary of what happened or was found'),
        is_goal_complete: z.boolean().describe('True if the user\'s goal is fully achieved'),
        options: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              url: z.string().optional(),
              file_type: z.string().optional(),
              rating: z.string().optional(),
              price: z.string().optional(),
            })
          )
          .optional()
          .describe('Relevant results, links, or items found on the page'),
        question_for_user: z
          .string()
          .optional()
          .describe('Set ONLY if you need clarification from the user to continue'),
      }),
    }
  );

  return [observePage, browserAct, finish] as const;
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
    // ─── LangChain AGENT (tool-calling ReAct via AgentExecutor) ───
    let finishPayload: FinishPayload | null = null;
    const tools = buildAgentTools(session.stagehand, (p) => { finishPayload = p; });

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You are Nav-Mate, a DOM-aware browser automation assistant helping elderly users navigate websites.

Your job:
1. Call observe_page to see the current page state.
2. Decide: if useful results are already visible, call finish with those results.
   If a useful action is possible (search bar, button, link), call browser_act with a precise instruction, then observe_page again.
   If you are blocked (login wall, no relevant elements), call finish with a question_for_user.
3. ALWAYS end by calling finish. Never leave the user without a response.
4. Keep actions simple and precise. One action at a time.
5. Do NOT think out loud. Use tools directly.`,
      ],
      new MessagesPlaceholder('chat_history'),
      ['human', '{input}'],
      new MessagesPlaceholder('agent_scratchpad'),
    ]);

    const llm = createLangChainLLM();
    const agent = await createToolCallingAgent({ llm, tools: tools as any, prompt });
    const executor = new AgentExecutor({
      agent,
      tools: tools as any,
      maxIterations: MAX_REACT_STEPS,
      returnIntermediateSteps: true,
      verbose: false,
    });

    // Map session history to LangChain message format
    const chatHistory = session.history
      .filter(h => !h.content.startsWith('[step '))  // skip intermediate act entries
      .map(h => h.role === 'user' ? new HumanMessage(h.content) : new AIMessage(h.content));

    console.log(`🧠 Invoking LangChain agent for: "${userGoal}"`);
    const agentResult = await executor.invoke({
      input: `Goal: ${session.goal ?? userGoal}\nLatest message: ${userGoal}`,
      chat_history: chatHistory,
    });

    // Extract thinking steps from intermediate steps
    type ThinkingStep = { step: number; thought: string; action_type: string; action_instruction: string | null };
    const thinkingSteps: ThinkingStep[] = (agentResult.intermediateSteps ?? []).map(
      (s: any, idx: number) => ({
        step: idx + 1,
        thought: s.action?.log ?? s.action?.toolInput?.instruction ?? s.action?.tool ?? '',
        action_type: s.action?.tool === 'finish' ? 'surface_options'
          : s.action?.tool === 'browser_act' ? 'act'
          : 'observe',
        action_instruction: s.action?.tool === 'browser_act'
          ? (s.action?.toolInput?.instruction ?? null)
          : null,
      })
    );

    console.log(`📊 Agent took ${thinkingSteps.length} steps`);

    // Update session history with a summary of what happened
    const agentSummary = finishPayload?.description ?? agentResult.output ?? 'Task attempted.';
    session.history.push({ role: 'agent', content: agentSummary });

    // Build the response from finish payload (or fallback to agent text output)
    if (finishPayload && finishPayload.question_for_user) {
      session.history.push({ role: 'agent', content: `[clarification] ${finishPayload.question_for_user}` });
      return res.json({
        status: 'needs_clarification',
        question: finishPayload.question_for_user,
        thinking_steps: thinkingSteps,
      });
    }

    const options: ExtractedOption[] = finishPayload?.options ?? [];
    const isComplete = finishPayload?.is_goal_complete ?? false;
    if (isComplete) await triggerConfirmationCall(session.goal ?? agentSummary);

    return res.json({
      status: 'action_complete',
      description: agentSummary,
      is_goal_complete: isComplete,
      extracted_options: options.length > 0 ? options : undefined,
      thinking_steps: thinkingSteps,
      suggestions: [
        options.length > 0 ? 'Click one of the options above to continue' : 'Tell me what to do next',
        'Ask me to refine or search for something else',
        'Ask me to navigate to a different section',
      ],
    });

  } catch (error) {
    console.error('❌ Error during LangChain agent:', error);
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
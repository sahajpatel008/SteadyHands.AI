import OpenAI from "openai";
import { z } from "zod";
import { getConfig } from "./config";
import { logMain } from "../../shared/logger";
import type {
  PageObservation,
  PlanActionInput,
  PlanActionResult,
  BrowserAction,
  SafetyValidationResult,
  SidebarChoice,
} from "../../shared/types";

const choiceSchema = z.object({
  label: z.string(),
  rationale: z.string(),
  suggestedAction: z.string(),
  elementId: z.string().optional(),
  actionType: z.enum(["click", "type", "select", "scroll", "navigate"]).optional(),
  actionValue: z.string().optional(),
});

const summarySchema = z.object({
  summary: z.string(),
  purpose: z.string(),
  current_step: z.string().optional(),
  choices: z.array(choiceSchema),
});

const stringOrNumber = z.union([z.string(), z.number()]).transform(String);

const actionSchema = z.union([
  z.object({
    done: z.literal(true),
    reasoning: z.string().default(""),
    finalAnswer: z
      .union([z.string(), z.number(), z.null(), z.undefined()])
      .transform((v) => (v == null || v === "" ? "Task completed." : String(v))),
    confidence: z
      .union([z.number(), z.string()])
      .transform((v) =>
        Math.min(1, Math.max(0, typeof v === "string" ? parseFloat(v) || 0.5 : v)),
      ),
  }),
  z.object({
    done: z.literal(false),
    reasoning: z.string().default(""),
    confidence: z
      .union([z.number(), z.string()])
      .transform((v) =>
        Math.min(1, Math.max(0, typeof v === "string" ? parseFloat(v) || 0.5 : v)),
      ),
    expectedOutcome: z.string().optional(),
    askQuestion: z.string().optional(),
    selectedChoiceIndex: z
      .union([z.number().int().positive(), z.string()])
      .optional()
      .transform((v) => {
        if (v == null) return undefined;
        const n = typeof v === "number" ? v : parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      }),
    action: z
      .object({
        type: z.string(),
        elementId: stringOrNumber.optional(),
        text: stringOrNumber.optional(),
        value: stringOrNumber.optional(),
        url: stringOrNumber.optional(),
      })
      .passthrough()
      .optional()
      .transform((a) => {
        if (!a) return undefined;
        const { type, elementId, text, value, url } = a;
        if (type === "click" && elementId)
          return { type: "click" as const, elementId: String(elementId) };
        if (type === "type" && elementId && (text != null || value != null))
          return {
            type: "type" as const,
            elementId: String(elementId),
            text: String(text ?? value),
          };
        if (type === "select" && elementId && value != null)
          return {
            type: "select" as const,
            elementId: String(elementId),
            value: String(value),
          };
        if (type === "scroll" && elementId)
          return { type: "scroll" as const, elementId: String(elementId) };
        if (type === "navigate" && url)
          return { type: "navigate" as const, url: String(url) };
        return undefined;
      }),
    mcpToolCall: z
      .object({
        server: z.string().min(1),
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
]);

const config = getConfig();
const client = new OpenAI({
  baseURL: config.vllmBaseUrl,
  apiKey: config.vllmApiKey,
});

const semanticCache = new Map<string, { expiresAt: number; value: unknown }>();
const semanticInFlight = new Map<string, Promise<unknown>>();
const planCache = new Map<string, { expiresAt: number; value: unknown }>();
const planInFlight = new Map<string, Promise<unknown>>();
const safetyCache = new Map<string, { expiresAt: number; value: unknown }>();
const safetyInFlight = new Map<string, Promise<unknown>>();
const summaryCache = new Map<string, { expiresAt: number; value: unknown }>();
const summaryInFlight = new Map<string, Promise<unknown>>();

const SEMANTIC_TTL_MS = 0;
const PLAN_TTL_MS = 0;
const SAFETY_TTL_MS = 8000;
const SUMMARY_TTL_MS = 8000;
const SEMANTIC_MAX_TOKENS = 500;
const PLAN_MAX_TOKENS = 500;
/** Max tokens for extended reasoning before action plan (reasoning + JSON output). */
const PLAN_REASONING_MAX_TOKENS = 2500;
const SAFETY_MAX_TOKENS = 260;
const SUMMARY_MAX_TOKENS = 520;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 24);
}

function logModelResponse(label: string, text: string, previewChars = 500): void {
  if (config.logLlmRaw) {
    logMain("llm", label, { text, textLen: text.length });
    return;
  }
  logMain("llm", label, { textPreview: text.slice(0, previewChars), textLen: text.length });
}

function prioritizeElements(
  observation: PageObservation,
  userGoal: string,
  maxElements: number,
): string {
  const tokens = tokenize(userGoal);
  const scored = observation.elements
    .map((el) => {
      const haystack =
        `${el.tag} ${el.role ?? ""} ${el.text ?? ""} ${el.ariaLabel ?? ""} ${el.placeholder ?? ""}`
          .toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 2;
        }
      }
      if (el.role === "button" || el.tag === "button") score += 1;
      if (el.tag === "input" || el.role === "combobox") score += 1;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxElements)
    .map(({ el }) => {
      const base = `${el.id} | ${el.tag} | ${el.role ?? "-"} | ${el.text || el.ariaLabel || "-"}`;
      return el.href ? `${base} | href=${el.href}` : base;
    });

  return scored.join("\n");
}

function stripThinkTags(text: string): string {
  // If model output is truncated with unclosed think tag, append closer so we can strip it
  let s = text;
  if (/<think>/i.test(s) && !/<\/think>/i.test(s)) {
    s = s + "</think>";
  }
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function tryRepairTruncatedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let fragment = text.slice(start);
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
  let lastCompleteEnd = -1;
  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") braceDepth += 1;
    if (ch === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) lastCompleteEnd = i + 1;
    }
    if (ch === "[") bracketDepth += 1;
    if (ch === "]") bracketDepth -= 1;
  }
  // If truncated inside a string, truncate back to last complete key-value and close
  if (inString && lastCompleteEnd < 0) {
    const patterns = ['",', "null,", "},", "],"];
    for (const p of patterns) {
      const idx = fragment.lastIndexOf(p);
      if (idx >= 0) {
        const cut = fragment.slice(0, idx + p.length - 1);
        try {
          const closed = cut + "}";
          JSON.parse(closed);
          return closed;
        } catch {
          continue;
        }
      }
    }
  }
  // Remove trailing comma before closing (invalid in JSON)
  fragment = fragment.replace(/,\s*$/, "");
  const repaired = fragment + "]".repeat(Math.max(0, bracketDepth)) + "}".repeat(Math.max(0, braceDepth));
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

function extractJson(text: string): unknown {
  const cleaned = stripThinkTags(text);
  let balanced = extractBalancedJsonObject(cleaned);
  if (!balanced) {
    balanced = tryRepairTruncatedJson(cleaned);
  }
  if (!balanced) {
    logMain("llm", "extractJson failed: no JSON object", {
      textPreview: cleaned.slice(0, 260),
    });
    throw new Error("Model output did not contain JSON object.");
  }

  try {
    return JSON.parse(balanced);
  } catch (e) {
    logMain("llm", "extractJson parse error", {
      raw: balanced.slice(0, 500),
      error: String(e),
    });
    throw e;
  }
}

function buildFallbackSemanticSummary(
  observation: PageObservation,
  userGoal: string,
): { summary: string; purpose: string; current_step: string; choices: SidebarChoice[] } {
  const goalTokens = tokenize(userGoal);
  const topChoices = observation.elements
    .slice(0, 5)
    .map((el) => {
      const text = `${el.text ?? ""} ${el.ariaLabel ?? ""} ${el.placeholder ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of goalTokens) {
        if (text.includes(token)) score += 2;
      }
      if (el.role === "button" || el.tag === "button") score += 1;
      if (el.tag === "input" || el.role === "combobox") score += 1;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ el }) => {
      const isInput = el.tag === "input" || el.tag === "textarea" || el.role === "combobox";
      const actionType: SidebarChoice["actionType"] = isInput ? "type" : "click";
      return {
        label: (el.text || el.ariaLabel || el.placeholder || `Use ${el.tag}`).slice(0, 80),
        rationale: "Fallback: model output was truncated.",
        suggestedAction: isInput ? "Type relevant text" : "Click to proceed",
        elementId: el.id,
        actionType,
        actionValue: isInput ? userGoal.slice(0, 120) : undefined,
      };
    });

  return {
    summary: `${observation.title} (${observation.url})`,
    purpose: "Page interaction and next-step guidance",
    current_step: observation.title || "Current Page",
    choices: topChoices,
  };
}

function buildContentParts(prompt: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: prompt }];
}

/** vLLM structured JSON schema for inferIntent. Enforces output shape and blocks extra fields. */
const INFER_INTENT_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    prompt_type: {
      type: "string" as const,
      enum: ["conversational", "task"],
      description: "conversational = chat reply; task = agent performs actions",
    },
    inferredGoal: { type: "string" as const, description: "Clear actionable goal" },
    plan: { type: "string" as const, description: "Numbered step-by-step plan" },
    planSteps: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Detailed step strings",
    },
    completion_point: { type: "string" as const, description: "Final state when done" },
    searchQuery: {
      type: ["string", "null"] as const,
      description: "Short query for first search, or null if no search needed",
    },
    clarifyingQuestion: { type: "string" as const, description: "Question if ambiguous" },
    requireUserInput: {
      type: "boolean" as const,
      description: "True when the agent must ask the user for more info before proceeding. Set when the message is ambiguous, incomplete, or user expressed uncertainty (e.g. 'idk which', 'not sure').",
    },
    choices: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          label: { type: "string" as const },
          goal: { type: "string" as const },
        },
        required: ["label", "goal"],
        additionalProperties: false,
      },
      description: "Alternative interpretations",
    },
  },
  required: ["prompt_type", "inferredGoal", "plan", "planSteps", "completion_point"],
  additionalProperties: false,
};

async function chatCompletion(
  model: string,
  content: Array<{ type: "text"; text: string }>,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    /** vLLM structured output: strict JSON schema. Takes precedence over jsonMode. */
    jsonSchema?: { name: string; schema: object };
    disableThinking?: boolean;
  },
): Promise<string> {
  const responseFormat = opts?.jsonSchema
    ? {
        type: "json_schema" as const,
        json_schema: {
          name: opts.jsonSchema.name,
          strict: true,
          schema: opts.jsonSchema.schema,
        },
      }
    : opts?.jsonMode
      ? { type: "json_object" as const }
      : undefined;

  const extraBody: Record<string, unknown> = {};
  if (opts?.disableThinking) {
    extraBody.chat_template_kwargs = { enable_thinking: false };
  }

  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content }],
    max_tokens: opts?.maxTokens,
    temperature: opts?.temperature ?? 0.1,
    response_format: responseFormat,
    extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
  });
  return completion.choices[0]?.message?.content ?? "";
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function getObservationSignature(observation: PageObservation): string {
  const elementSlice = observation.elements
    .slice(0, 30)
    .map((el) => `${el.id}|${el.tag}|${el.role ?? ""}|${el.text ?? ""}`)
    .join(";");
  return hashString(
    `${observation.url}::${observation.title}::${observation.mainText.slice(0, 1400)}::${observation.elements.length}::${elementSlice}`,
  );
}

async function withMemo<T>(
  key: string,
  ttlMs: number,
  cache: Map<string, { expiresAt: number; value: unknown }>,
  inFlight: Map<string, Promise<unknown>>,
  loader: () => Promise<T>,
  label: string,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    logMain("llm", `${label} cache hit`, { key: key.slice(0, 16) });
    return cached.value as T;
  }

  const existing = inFlight.get(key);
  if (existing) {
    logMain("llm", `${label} in-flight dedupe`, { key: key.slice(0, 16) });
    return (await existing) as T;
  }

  const pending = loader()
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + ttlMs, value });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, pending as Promise<unknown>);
  return pending;
}

const intentSchema = z.object({
  /** "conversational" = user wants a chat reply (questions, explanations). "task" = user wants agent to perform actions (search, navigate, fill forms). */
  prompt_type: z
    .enum(["conversational", "task"])
    .optional()
    .default("task")
    .transform((v) => (v === "conversational" ? "conversational" : "task")),
  inferredGoal: z.string(),
  plan: z.string(),
  planSteps: z
    .array(z.string())
    .optional()
    .transform((v) => v?.filter((s) => s.trim().length > 0) ?? []),
  /** Final state the agent should achieve. Used to detect when to stop. */
  completion_point: z.string().optional(),
  searchQuery: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v == null || v === "" ? undefined : v)),
  clarifyingQuestion: z
    .union([z.string(), z.null(), z.undefined()])
    .optional()
    .transform((v) => (typeof v === "string" ? v : undefined)),
  requireUserInput: z
    .union([z.boolean(), z.string()])
    .optional()
    .default(false)
    .transform((v) => v === true || v === "true"),
  choices: z
    .union([
      z.array(z.object({ label: z.string(), goal: z.string() })),
      z.null(),
      z.undefined(),
    ])
    .optional()
    .transform((v) => (Array.isArray(v) ? v : [])),
});

export type InferIntentResult = z.infer<typeof intentSchema>;

/** Infer user intent and create a plan before taking action. Call for every user prompt. */
export async function inferIntent(rawGoal: string): Promise<InferIntentResult> {
  logMain("llm", "inferIntent start", { rawGoalLen: rawGoal.length });
  const model = config.summarizerModel;
  const prompt = `You are an intent inference system. For the user's raw message, think deeply and thoroughly about what they actually want to do.
Resolve ambiguities, infer context, and produce a clear operational goal plus a step-by-step plan.

CRITICAL: Return ONLY the keys listed below. Do NOT add error, response, features, timestamp, metadata, or any other fields.

Return a JSON object with EXACTLY these keys:
- prompt_type: "conversational" or "task". Use "conversational" when the user wants a chat reply—questions, explanations, general discussion, opinions, definitions, how-to advice without doing it. Use "task" when the user wants the agent to perform actions—search the web, navigate, fill forms, click, download, book, etc.
- inferredGoal: A clear, actionable goal statement (what the user wants to achieve)
- plan: A numbered step-by-step plan (what to do first, second, etc.). Be specific. Include search terms, sites, or actions when inferable.
- planSteps: Array of DETAILED step strings, one per step. Each step must be a single actionable task the agent can execute. Include the TARGET we're looking for (e.g. "Click IRS.gov link in search results", "Find and click Form 1040-SR PDF link on page", "Download PDF from form page"). Be specific about what to look for on each page.
- completion_point: A concise description of the FINAL state when the goal is achieved. The agent stops when it reaches this state. Examples: "IRS Form 1040-SR PDF page visible or downloadable on irs.gov", "Flight search results with Tokyo as destination", "Movie showtimes or streaming options displayed". Be specific enough to detect success.
- searchQuery: (optional) If the first step involves a web search, the SHORT query to type (e.g. "Form 1040-SR" or "IRS Form 1040-SR PDF"). Never the full goal or plan text. Max 80 chars.
- clarifyingQuestion: (optional) If the intent is ambiguous, one short question to help the user refine (e.g. "Do you want theater showtimes, streaming recommendations, or both?")
- requireUserInput: (boolean) Set TRUE when the agent must ask the user for more info before proceeding. Set true when: (a) the user expressed uncertainty ("idk which", "don't know", "not sure which", "any"), (b) the message is ambiguous or incomplete, (c) there are multiple valid interpretations and the user didn't specify. Set false when the goal is clear and actionable.
- choices: (optional) Array of 0-3 alternative interpretations when ambiguous. Each: { "label": "Short button label", "goal": "Full goal for this option" }

Examples:
- "what is IRS Form 1040-SR?" -> prompt_type: "conversational", inferredGoal: "Explain IRS Form 1040-SR", plan: "Answer the question directly"
- "download IRS Form 1040-SR" -> prompt_type: "task", inferredGoal: "Find and download IRS Form 1040-SR", plan: "1. Search for Form 1040-SR 2. Click IRS link 3. Download PDF", planSteps: ["Search for Form 1040-SR on Google", "Click IRS.gov or official tax form link in search results", "On form page: find and click Form 1040-SR PDF download link", "Download or open the PDF"], completion_point: "IRS Form 1040-SR PDF page visible or downloadable on irs.gov", searchQuery: "IRS Form 1040-SR PDF", requireUserInput: false
- "i wanna go to irs and download a form idk which" -> prompt_type: "task", inferredGoal: "Navigate to IRS and download a tax form (user unspecified which form)", plan: "1. Search for IRS.gov 2. Navigate to forms page 3. Ask user which form 4. Download selected form", planSteps: ["Search for IRS.gov on Google", "Click IRS.gov link in search results", "Navigate to forms page on irs.gov", "Ask user which form they need", "Download the form the user selects"], completion_point: "User has specified which form and we have navigated to it or downloaded it", searchQuery: "IRS.gov forms", clarifyingQuestion: "Which IRS form do you need? (e.g. Form 1040, 1040-SR, W-2, 1099)", requireUserInput: true
- "i wanna see a movie" -> prompt_type: "task", inferredGoal: "Find movie recommendations", plan: "1. Search for movie recommendations 2. Present options", completion_point: "Movie recommendations or showtimes displayed", searchQuery: "movie recommendations"
- "book flight to tokyo" -> prompt_type: "task", inferredGoal: "Book a flight to Tokyo", plan: "1. Navigate to flight search 2. Enter Tokyo 3. Select dates 4. Search", completion_point: "Flight search results with Tokyo as destination", searchQuery: "flights to Tokyo"

When the user expresses uncertainty ("idk which", "don't know which", "not sure which", "any"), set requireUserInput: true and include clarifyingQuestion. The agent will ask before proceeding.

User message:
${rawGoal}`;

  const content = buildContentParts(prompt);
  const text = await chatCompletion(model, content, {
    maxTokens: 1200,
    jsonSchema: {
      name: "infer_intent",
      schema: INFER_INTENT_JSON_SCHEMA,
    },
  });
  logModelResponse("inferIntent raw response", text, 400);
  const parsed = intentSchema.parse(extractJson(text));
  if (!parsed.planSteps?.length && parsed.plan) {
    parsed.planSteps = parsed.plan
      .split(/\d+\.\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  logMain("llm", "inferIntent done", {
    prompt_type: parsed.prompt_type,
    inferredGoalLen: parsed.inferredGoal.length,
    planLen: parsed.plan.length,
    planSteps: parsed.planSteps?.length ?? 0,
    requireUserInput: parsed.requireUserInput,
    choices: parsed.choices?.length ?? 0,
  });
  return parsed;
}

export type RefinedGoalResult = {
  refinedGoal: string;
  completion_point?: string;
  planSteps?: string[];
  searchQuery?: string;
};

/** Refine the goal, completion_point, and plan from user's clarification. Call when user answers a clarifying question. */
export async function refineGoalFromUserInput(
  originalGoal: string,
  userAnswer: string,
  question: string,
): Promise<RefinedGoalResult> {
  logMain("llm", "refineGoalFromUserInput start", {
    answerLen: userAnswer.length,
    question: question.slice(0, 60),
  });
  const model = config.summarizerModel;
  const prompt = `The agent asked the user: "${question}"
The user answered: "${userAnswer}"

The original goal/plan was:
${originalGoal.slice(0, 2000)}

First, determine which case applies:
A) CLARIFYING AMONG OPTIONS: The user is picking from the options offered (e.g. "the first one", "option 2", "yes", "no" to one option). Keep the same overall goal; append their choice.
B) NEW GOAL: The user is giving a completely different instruction (e.g. "go to irs and get me the 1040sr form", "actually I need the W-2", "navigate to example.com"). Replace the goal with their new instruction.

For case B (NEW GOAL), the refinedGoal MUST use this exact format so the planner recognizes it:
- Include a line: "User clarification: [NEW GOAL] {user's exact instruction}"
- Put the user's new instruction as the primary inferred goal at the top.
- Example: "Inferred goal: Navigate to IRS.gov and download Form 1040-SR.\n\nUser clarification: [NEW GOAL] go to irs and get me the 1040sr form"

For case A (clarifying among options), use: "User clarification: {their choice}"

Return ONLY a JSON object with these keys:
- refinedGoal: string (updated goal; for NEW GOAL use the format above so planner can detect it)
- completion_point: string (when we're done)
- planSteps: array of strings (updated plan steps; for NEW GOAL include "Navigate to [target site]", "Search for [query]", etc.)
- searchQuery: string or null (short search query; for NEW GOAL use e.g. "IRS.gov Form 1040-SR" or "irs 1040sr form")`;

  const content = buildContentParts(prompt);
  const text = await chatCompletion(model, content, {
    maxTokens: 800,
    jsonMode: true,
  });
  logModelResponse("refineGoalFromUserInput raw", text, 400);
  const raw = extractJson(text) as {
    refinedGoal?: string;
    completion_point?: string;
    planSteps?: string[];
    searchQuery?: string | null;
  };
  const result: RefinedGoalResult = {
    refinedGoal: raw.refinedGoal ?? `${originalGoal}\n\nUser clarification: ${userAnswer}`,
    completion_point: raw.completion_point,
    planSteps: Array.isArray(raw.planSteps) ? raw.planSteps.filter((s) => typeof s === "string") : undefined,
    searchQuery: typeof raw.searchQuery === "string" ? raw.searchQuery : undefined,
  };
  logMain("llm", "refineGoalFromUserInput done", {
    refinedGoalLen: result.refinedGoal.length,
    completion_point: result.completion_point?.slice(0, 60),
    planStepsLen: result.planSteps?.length ?? 0,
  });
  return result;
}

/** Generate a conversational reply when the user asks a question or wants discussion (no task execution). */
export async function respondConversationally(userMessage: string): Promise<string> {
  logMain("llm", "respondConversationally start", { userMessageLen: userMessage.length });
  const model = config.summarizerModel;
  const prompt = `You are a helpful assistant. The user has asked a conversational question or wants a discussion—they do NOT want you to search the web or perform browser actions.

Respond helpfully, concisely, and directly. Be informative but keep the response focused. If the question is ambiguous, you may ask a brief clarifying question.

User message:
${userMessage}`;

  const content = buildContentParts(prompt);
  const text = await chatCompletion(model, content, {
    maxTokens: 1024,
    temperature: 0.3,
  });
  const reply = stripThinkTags(text ?? "").trim();
  logMain("llm", "respondConversationally done", { replyLen: reply.length });
  return reply || "I'm not sure how to respond to that. Could you rephrase?";
}

/** Semantic Interpreter ("Eyes"): Raw DOM -> simplified JSON schema of top actions for user_goal */
export async function semanticInterpreter(
  observation: PageObservation,
  userGoal: string,
  opts?: { searchQuery?: string },
): Promise<{
  summary: string;
  purpose: string;
  current_step: string;
  choices: SidebarChoice[];
}> {
  const searchQuery = opts?.searchQuery;
  logMain("llm", "semanticInterpreter start", {
    url: observation.url,
    userGoal: userGoal?.slice(0, 60),
    searchQuery: searchQuery?.slice(0, 40),
  });
  logMain("llm", "semanticInterpreter mode", { visionEnabled: false });
  const observationSig = getObservationSignature(observation);
  const cacheKey = hashString(
    `${config.summarizerModel}::${userGoal.slice(0, 400)}::${searchQuery ?? ""}::${observationSig}`,
  );

  return withMemo(
    cacheKey,
    SEMANTIC_TTL_MS,
    semanticCache,
    semanticInFlight,
    async () => {
      const slimText = observation.mainText.slice(0, 4500);
      const prioritizedElements = prioritizeElements(observation, userGoal, 60);
      const prompt = `
You are the Semantic Interpreter ("Eyes"). Convert raw page data into a simplified JSON schema of actions.
Output ONLY a single JSON object—no think tags, no markdown, no commentary.

CRITICAL: Thoroughly scan the ENTIRE page content before deciding. Check all visible links, headings, buttons, and text for the target. Do not miss relevant options buried in the page.

Given the user's goal, return ONLY the TOP 3-5 actions that directly help the goal.
Prioritize options that match the goal (e.g. for "Form 1040-SR" prefer IRS/form links over generic navigation).
Never include options that are page-generic, ads, or not relevant to the user goal.
Each choice must map to a real element/action from the provided elements list.

Return STRICT JSON:
{
  "summary": "Brief page description",
  "purpose": "What this page is for",
  "current_step": "e.g. Login Page, Search Results, Dashboard",
  "choices": [
    {
      "label": "Human-readable label",
      "rationale": "Why this helps the user",
      "suggestedAction": "What will happen",
      "elementId": "sh-N (required when actionType is click/type/select/scroll)",
      "actionType": "click|type|select|scroll|navigate",
      "actionValue": "Required for type/select/navigate. Omit for click/scroll."
    }
  ]
}

CRITICAL for search boxes (Google, etc.): For type actions, use ONLY a short search query (e.g. "Form 1040-SR"), NEVER the full goal or plan text.
${searchQuery ? `\nSearch query to use for type actions in search boxes: "${searchQuery}"` : ""}

User goal: ${userGoal}
Page title: ${observation.title}
Page URL: ${observation.url}
Visible text:
${slimText}

Interactive elements (use elementId exactly as shown):
${prioritizedElements}
`;

      const content = buildContentParts(prompt);
      const text = await chatCompletion(config.summarizerModel, content, {
        maxTokens: config.turboMode ? SEMANTIC_MAX_TOKENS : 520,
        disableThinking: true,
        jsonMode: true,
      });
      logModelResponse("semanticInterpreter raw response", text, 900);
      try {
        const parsed = summarySchema.parse(extractJson(text));
        logMain("llm", "semanticInterpreter done", {
          choices: parsed.choices?.length,
          current_step: parsed.current_step,
        });
        return parsed as ReturnType<typeof semanticInterpreter> extends Promise<infer R>
          ? R
          : never;
      } catch (error) {
        logMain("llm", "semanticInterpreter parse fallback", {
          error: error instanceof Error ? error.message : String(error),
          textPreview: text.slice(0, 260),
        });
        const fallback = buildFallbackSemanticSummary(observation, userGoal);
        if (searchQuery && /google\.com/i.test(observation.url)) {
          fallback.choices = fallback.choices.map((c) =>
            c.actionType === "type"
              ? { ...c, actionValue: searchQuery.slice(0, 120) }
              : c,
          );
        }
        return fallback;
      }
    },
    "semanticInterpreter",
  );
}

/** Safety Supervisor ("Guardrails"): Validates action against user intent before execution */
export async function safetySupervisor(
  userGoal: string,
  action: BrowserAction,
  context: { url: string; currentStep?: string },
): Promise<SafetyValidationResult> {
  logMain("llm", "safetySupervisor start", {
    goal: userGoal?.slice(0, 50),
    actionType: action.type,
  });

  const cacheKey = hashString(
    `${config.plannerModel}::${userGoal.slice(0, 300)}::${context.url}::${context.currentStep ?? ""}::${JSON.stringify(action)}`,
  );

  return withMemo(
    cacheKey,
    SAFETY_TTL_MS,
    safetyCache,
    safetyInFlight,
    async () => {
      const actionDesc =
        action.type === "click"
          ? `click element ${action.elementId}`
          : action.type === "type"
            ? `type "${action.text}" into ${action.elementId}`
            : action.type === "navigate"
              ? `navigate to ${action.url}`
              : JSON.stringify(action);

      const prompt = `
You are the Safety Supervisor ("Guardrails"). Validate that the proposed action aligns with the user's intent.
Return STRICT JSON only:
{
  "approved": true|false,
  "reason": "Brief explanation",
  "requiresHITL": true|false
}

Rules:
- approved: true only if the action clearly advances the user's goal. Reject if it could be phishing, accidental, or off-goal.
- approved: false ALWAYS for login, sign-in, sign-up, authentication, payment, checkout, password entry, or any action requiring strict user info/intervention. The agent must stop before these—never proceed.
- requiresHITL: true if the action involves payments, money, confirmations, account changes, or sensitive data. User must confirm before execution.

User goal: ${userGoal}
Proposed action: ${actionDesc}
Current URL: ${context.url}
Current step: ${context.currentStep ?? "Unknown"}
`;

      const content = buildContentParts(prompt);
      const text = await chatCompletion(config.plannerModel, content, {
        maxTokens: config.turboMode ? SAFETY_MAX_TOKENS : 220,
      });
      const raw = extractJson(text) as {
        approved?: boolean;
        reason?: string;
        requiresHITL?: boolean;
      };
      const result: SafetyValidationResult = {
        approved: !!raw.approved,
        reason: raw.reason ?? "No reason given",
        requiresHITL: !!raw.requiresHITL,
      };
      logMain("llm", "safetySupervisor done", result);
      return result;
    },
    "safetySupervisor",
  );
}

/** Check if action description suggests HITL (payment, confirm, etc.) */
export function isRiskyForHITL(action: BrowserAction): boolean {
  const s = JSON.stringify(action).toLowerCase();
  return (
    /\$|pay|payment|confirm|transfer|withdraw|submit.*order|purchase|buy now/i.test(s) ||
    (action.type === "navigate" && /checkout|payment|pay\./i.test(action.url))
  );
}

export async function summarizePage(observation: PageObservation) {
  logMain("llm", "summarizePage start", {
    url: observation.url,
    elements: observation.elements?.length,
  });
  logMain("llm", "summarizePage mode", { visionEnabled: false, textOnly: true });

  const cacheKey = hashString(
    `${config.summarizerModel}::${getObservationSignature(observation)}`,
  );

  return withMemo(
    cacheKey,
    SUMMARY_TTL_MS,
    summaryCache,
    summaryInFlight,
    async () => {
      const slimText = observation.mainText.slice(0, 4000);
      const prompt = `
You are an accessibility assistant for senior users.
Thoroughly scan the page content before suggesting actions.
Given page data, return STRICT JSON with keys: summary, purpose, choices[].
Each choice item must include label, rationale, suggestedAction. Include elementId when you can map to an element.
Keep language plain and short.

Page title: ${observation.title}
Page URL: ${observation.url}
Visible text:
${slimText}

Interactive elements (id + text + role):
${observation.elements
  .slice(0, 60)
  .map((el) => `${el.id} | ${el.tag} | ${el.role ?? "-"} | ${el.text || el.ariaLabel || "-"}${el.href ? " | href=" + el.href : ""}`)
  .join("\n")}
`;

      const content = buildContentParts(prompt);
      const text = await chatCompletion(config.summarizerModel, content, {
        maxTokens: config.turboMode ? SUMMARY_MAX_TOKENS : 420,
      });
      logModelResponse("summarizePage raw response", text, 900);
      const parsed = summarySchema.parse(extractJson(text));
      logMain("llm", "summarizePage parsed", {
        summaryLen: parsed.summary?.length,
        choices: parsed.choices?.length,
      });
      return parsed;
    },
    "summarizePage",
  );
}

export async function planAction(input: PlanActionInput): Promise<PlanActionResult> {
  const stepCount = input.timeline.filter((t) => t.kind === "act").length;
  logMain("llm", "planAction start", {
    goal: input.goal?.slice(0, 80),
    url: input.observation.url,
    stepCount,
    elements: input.observation.elements?.length,
    availableActions: input.availableActions?.length ?? 0,
    availableMcpTools: input.availableMcpTools?.length ?? 0,
  });

  const confidenceThreshold = config.confidenceThreshold;
  const plannerModel = config.fastPlannerModel ?? config.plannerModel;
  const mcpTools = input.availableMcpTools ?? [];
  const numberedActions = input.availableActions
    .map((choice, index) => {
      return `${index + 1}. label=${choice.label} | rationale=${choice.rationale} | suggestedAction=${choice.suggestedAction} | actionType=${choice.actionType ?? "-"} | elementId=${choice.elementId ?? "-"} | actionValue=${choice.actionValue ?? "-"}`;
    })
    .join("\n");
  const numberedMcpTools = mcpTools
    .map((tool, index) => {
      const schemaSnippet = tool.inputSchema
        ? JSON.stringify(tool.inputSchema).slice(0, 220)
        : "{}";
      return `${index + 1}. ${tool.server}/${tool.name} | ${tool.description ?? "-"} | inputSchema=${schemaSnippet}`;
    })
    .join("\n");
  const timelineTail = input.timeline
    .slice(-6)
    .map((t) => `${t.kind}: ${t.message}`)
    .join("\n");
  const planQueueSig = input.planSteps?.length
    ? `${input.planStepIndex ?? 0}::${input.planSteps.join("|").slice(0, 200)}`
    : "";
  const cacheKey = hashString(
    `${plannerModel}::${input.goal.slice(0, 260)}::${input.observation.url}::${input.currentStep ?? ""}::${planQueueSig}::${timelineTail}::${numberedActions}::${numberedMcpTools}`,
  );

  const planQueueBlock =
    input.planSteps?.length && input.planStepIndex != null
      ? `
PLAN QUEUE (reference this BEFORE deciding—your action must achieve the CURRENT step):
${input.planSteps.map((s, i) => `${i + 1}. ${s}${i === input.planStepIndex! ? " <-- CURRENT" : ""}`).join("\n")}

`
      : "";

  return withMemo(
    cacheKey,
    PLAN_TTL_MS,
    planCache,
    planInFlight,
    async () => {
      const prompt = `
You are a browser action planner. Return STRICT JSON only.
Output ONLY a single JSON object—no think tags, no markdown, no commentary before or after.
Pick only ONE next step per response.
Always include confidence 0-1. If confidence < ${confidenceThreshold}, return askQuestion instead of action.

EXTENDED REASONING (max 2000 tokens): Before determining the action plan, use extended thinking and reasoning. Think through the page content, options, and goal. Then verify that your reasoning is complete. If not complete, append new reasoning. Only after your reasoning is complete, output the final JSON decision.

BEFORE EACH DECISION: Reference the plan queue below. Your action must achieve the CURRENT step.
${planQueueBlock}

CRITICAL: Do NOT return done=true until the user's goal is FULLY achieved.
- Navigating to a site is NEVER completion. You must fill forms, click buttons, search, etc.
- For "book a flight SFO to MUM tomorrow": you must navigate to a flight search page (e.g. google.com/travel/flights), fill origin SFO, destination MUM/BOM, date tomorrow, click search. Only done when search results are shown or user has selected a flight.
- One action per step. Keep going until the goal is achieved.

USER UNCERTAINTY (CRITICAL): If the goal or original message indicates the user doesn't know which option (e.g. "idk which", "don't know which", "not sure which", "any"), NEVER auto-select. Return askQuestion with confidence 0.3. List the available options and ask them to choose. The current plan step may say "Ask user which form" or similar—in that case, return askQuestion.

MULTIPLE SIMILAR OPTIONS: When 2+ options could fit the goal (e.g. multiple tax forms, similar links) and the user did NOT specify which one, return askQuestion. Do not guess. Use confidence below threshold.

DO NOT RE-ASK: If the goal already contains user clarification (e.g. "User clarification: 1040sr", "1040sr", or similar), the user has ALREADY answered. Do NOT return askQuestion with "Are you sure you need help with X?" or similar. Proceed with the action using the clarified info. Never ask for confirmation of info the user already gave.

ACTION SOURCE OF TRUTH:
- Thoroughly check the page content below before deciding. The target (e.g. form link, download button) may be in the content.
- Prefer ONLY the numbered semantic options below.
- If a PLAN QUEUE is provided above, pick the action that achieves the CURRENT step in the queue.
- If the CURRENT step says "Ask user" or "Ask which", return askQuestion—do not select.
- If options exist and user DID specify which one, return selectedChoiceIndex (1-based) for the BEST MATCHING choice.
- Avoid irrelevant links (ads, unrelated sites, generic navigation). Pick the option that directly advances the goal.
- If user says "option N", pick that exact valid index when possible.
- Return raw action only when there are zero executable semantic options.

USER CHANGED GOAL (CRITICAL): When the goal contains "User clarification:" followed by a NEW destination or task (e.g. "go to irs", "[NEW GOAL] get 1040sr form", "navigate to IRS.gov", "download 1040-SR") and the current page/URL does NOT match that target—ignore the semantic options and return a raw navigate or type action instead:
  - If on google.com: return action with type "type" to search for the new target (e.g. "IRS.gov Form 1040-SR"), or type "navigate" with the direct URL if known (e.g. "https://www.irs.gov/forms-pubs/about-form-1040-sr").
  - If NOT on google.com: return action with type "navigate" to "https://www.google.com/search?q=" + encoded search query for the new goal, so we can then search and reach the target.
  - Do NOT ask the user to confirm. The user has already given a direct instruction. Proceed immediately.

MCP TOOL USE:
- Use MCP tools when browser actions cannot directly obtain required external data or perform non-UI tasks.
- If using MCP tool, return mcpToolCall with {server, name, arguments}.
- Do not call MCP tools for actions already available as executable sidebar browser options.

GOOGLE SEARCH: When on google.com and the user wants to search, type ONLY a short search query (e.g. "Form 1040-SR" or "flights to Tokyo") into the main search box. NEVER type the full goal, plan, or "Inferred goal:" text. Use the search query from the goal context. Pick the choice whose actionValue is the short query.

User goal: ${input.goal}
Current URL: ${input.observation.url}
Current title: ${input.observation.title}

Page content (scan thoroughly before deciding):
${input.observation.mainText.slice(0, 3000)}
Current interpreted step: ${input.currentStep ?? "Unknown"}
Steps taken so far: ${stepCount}
Recent timeline:
${timelineTail}

Numbered semantic options:
${numberedActions || "(none)"}

Available MCP tools:
${numberedMcpTools || "(none)"}

If goal is FULLY achieved (user has what they asked for), return:
{"done": true, "reasoning": "...", "finalAnswer": "Summary of what was done.", "confidence": 0.95}

If confidence < ${confidenceThreshold}, return:
{"done": false, "reasoning": "...", "confidence": 0.4, "askQuestion": "Clarifying question for user"}

If semantic options exist, pick the BEST matching one (most relevant to goal) and return:
{"done": false, "reasoning": "...", "confidence": 0.85, "expectedOutcome": "...", "selectedChoiceIndex": 2}

If MCP tool is needed, return:
{"done": false, "reasoning": "...", "confidence": 0.85, "expectedOutcome": "...", "mcpToolCall": {"server": "serverName", "name": "toolName", "arguments": {}}}

If user changed goal (goal contains "User clarification:" with new site/task and current page is irrelevant), return raw navigate or type action even if semantic options exist:
{"done": false, "reasoning": "User requested different site/task. Navigating to reach it.", "confidence": 0.9, "expectedOutcome": "...", "action": {"type": "navigate", "url": "https://www.google.com/search?q=..."} or {"type": "type", "elementId": "...", "text": "short search query"}}

Otherwise, only if no executable semantic options exist, return ONE raw action:
{"done": false, "reasoning": "...", "confidence": 0.85, "expectedOutcome": "...", "action": {"type": "click"|"type"|"select"|"scroll"|"navigate", ...}}
`;

      const content = buildContentParts(prompt);
      const maxTokens = PLAN_REASONING_MAX_TOKENS;
      let text = await chatCompletion(plannerModel, content, {
        maxTokens,
        disableThinking: false,
        jsonMode: true,
      });
      logModelResponse("planAction raw response", text, 900);
      let parsed: PlanActionResult;
      try {
        parsed = actionSchema.parse(extractJson(text));
      } catch (e) {
        logMain("llm", "planAction parse failed, retrying without extended thinking", {
          error: String(e),
        });
        text = await chatCompletion(plannerModel, content, {
          maxTokens: 512,
          disableThinking: true,
          jsonMode: true,
        });
        logModelResponse("planAction retry raw response", text, 900);
        parsed = actionSchema.parse(extractJson(text));
      }
      logMain("llm", "planAction parsed", {
        done: parsed.done,
        confidence: parsed.confidence,
        askQuestion: parsed.askQuestion?.slice(0, 80),
        selectedChoiceIndex: !parsed.done ? parsed.selectedChoiceIndex : undefined,
        mcpToolCall:
          !parsed.done && parsed.mcpToolCall
            ? `${parsed.mcpToolCall.server}/${parsed.mcpToolCall.name}`
            : undefined,
        action: (parsed as { action?: unknown }).action,
      });
      if (
        !parsed.done &&
        !parsed.askQuestion &&
        parsed.selectedChoiceIndex == null &&
        !parsed.mcpToolCall &&
        !parsed.action
      ) {
        return {
          done: false,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          askQuestion: "Can you clarify what exact outcome you want on this page?",
        };
      }
      if (!parsed.done && parsed.confidence < confidenceThreshold && !parsed.askQuestion) {
        logMain("llm", "planAction low confidence fallback", {
          confidence: parsed.confidence,
          threshold: confidenceThreshold,
        });
        return {
          done: false,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          askQuestion: "I am not fully sure what to do next. What specific option should I choose?",
        };
      }
      logMain("llm", "planAction returning", {
        done: parsed.done,
        hasAction: !!(parsed as { action?: unknown }).action,
      });
      return parsed;
    },
    "planAction",
  );
}

/** Check if the current page is relevant to the user's goal. Used to go back when a click/navigate led to an irrelevant page. */
export async function isPageRelevantToGoal(
  observation: PageObservation,
  goal: string,
  opts?: { planSteps?: string[]; planStepIndex?: number },
): Promise<boolean> {
  const slimText = observation.mainText.slice(0, 3500);
  const linksAndButtons = observation.elements
    .filter((el) => el.href || el.tag === "a" || el.tag === "button" || el.role === "link" || el.role === "button")
    .slice(0, 35)
    .map((el) => {
      const text = [el.text, el.ariaLabel].filter(Boolean).join(" ").trim().slice(0, 80);
      const href = el.href ? ` -> ${el.href}` : "";
      return `- ${text || "(no label)"}${href}`;
    })
    .join("\n");

  const currentStepHint =
    opts?.planSteps?.length && opts.planStepIndex != null
      ? `\nCurrent plan step we're trying to achieve: ${opts.planSteps[opts.planStepIndex] ?? opts.planSteps[opts.planSteps.length - 1]}\n`
      : "";

  const prompt = `Is this web page relevant to the user's goal? Answer yes or no only.

User goal: ${goal.slice(0, 400)}
${currentStepHint}

Page URL: ${observation.url}
Page title: ${observation.title}
Visible text (excerpt): ${slimText.slice(0, 2500)}

Links and buttons on page (check these for the target):
${linksAndButtons || "(none extracted)"}

RELEVANT = page HAS the target (e.g. form link, download button, PDF) OR contains a link/path to it. A listing page with links to the form IS relevant.
NOT relevant = wrong site, login wall, error page, unrelated content, ads, generic homepage with NO path to the goal.

Answer:`;

  // URL heuristic: irs.gov PDF with 1040-SR/f1040s is the target
  const urlLower = observation.url.toLowerCase();
  if (
    /irs\.gov/i.test(urlLower) &&
    (/1040[- ]?sr|f1040s|1040sr/i.test(urlLower) || /\/irs-pdf\/|\.pdf/i.test(urlLower))
  ) {
    logMain("llm", "isPageRelevantToGoal", { url: observation.url, relevant: true, reason: "url_heuristic" });
    return true;
  }

  const content = buildContentParts(prompt);
  const rawText = await chatCompletion(config.summarizerModel, content, {
    maxTokens: 30,
    disableThinking: true,
  });
  const text = stripThinkTags(rawText);
  const answer = text.trim().toLowerCase();
  const relevant = /^\s*yes\b/i.test(answer);
  logMain("llm", "isPageRelevantToGoal", { url: observation.url, relevant, answerPreview: answer.slice(0, 30) });
  return relevant;
}

/** Check if the user's goal is fully achieved on this page. When true, agent should stop immediately. */
export async function isGoalAchieved(
  observation: PageObservation,
  goal: string,
): Promise<boolean> {
  const urlLower = observation.url.toLowerCase();
  const goalLower = goal.toLowerCase();

  // IRS form: we're on the form PDF/page and goal mentions IRS/1040/tax form
  if (
    /irs\.gov/i.test(urlLower) &&
    (/1040[- ]?sr|f1040s|1040sr|irs-pdf|\.pdf/i.test(urlLower)) &&
    (/1040|irs|tax\s*form|form\s*1040/i.test(goalLower))
  ) {
    logMain("llm", "isGoalAchieved", { url: observation.url, achieved: true, reason: "irs_form_heuristic" });
    return true;
  }

  // Generic: PDF on gov domain when goal mentions "form" or "download"
  if (
    /\.pdf$/i.test(urlLower) &&
    /\.gov\//i.test(urlLower) &&
    (/form|download|pdf/i.test(goalLower))
  ) {
    logMain("llm", "isGoalAchieved", { url: observation.url, achieved: true, reason: "gov_pdf_heuristic" });
    return true;
  }

  return false;
}

/** Check if the current page matches the completion_point (final state from inferIntent). */
export async function isAtCompletionPoint(
  observation: PageObservation,
  completionPoint: string,
): Promise<boolean> {
  if (!completionPoint.trim()) return false;

  const urlLower = observation.url.toLowerCase();
  const cpLower = completionPoint.toLowerCase();

  // Fast heuristic: completion_point often mentions irs.gov + 1040-SR
  if (
    /irs\.gov|1040|tax\s*form|form\s*1040/i.test(cpLower) &&
    /irs\.gov/i.test(urlLower) &&
    (/1040[- ]?sr|f1040s|1040sr|irs-pdf|\.pdf/i.test(urlLower))
  ) {
    logMain("llm", "isAtCompletionPoint", { url: observation.url, achieved: true, reason: "heuristic" });
    return true;
  }

  const slimText = observation.mainText.slice(0, 3000);
  const prompt = `Is this web page the completion point? Answer yes or no only.

Completion point (final state we want): ${completionPoint}

Page URL: ${observation.url}
Page title: ${observation.title}
Visible text (excerpt): ${slimText.slice(0, 2000)}

YES = the page clearly shows or delivers what the completion point describes (e.g. form PDF visible, target content displayed).
NO = we're on an intermediate page (search results, listing, navigation) or wrong page.

Answer:`;

  const content = buildContentParts(prompt);
  const rawText = await chatCompletion(config.summarizerModel, content, {
    maxTokens: 30,
    disableThinking: true,
  });
  const text = stripThinkTags(rawText);
  const answer = text.trim().toLowerCase();
  const achieved = /^\s*yes\b/i.test(answer);
  logMain("llm", "isAtCompletionPoint", { url: observation.url, achieved, answerPreview: answer.slice(0, 30) });
  return achieved;
}

/** Map user's natural-language answer to a choice index (1-based) using semantic reasoning. */
export async function resolveUserChoiceToIndex(
  answer: string,
  choices: SidebarChoice[],
  question?: string,
): Promise<number | null> {
  const trimmed = answer.trim();
  if (!trimmed || choices.length === 0) return null;

  const choicesText = choices
    .map((c, i) => `${i + 1}. ${c.label} — ${c.suggestedAction}`)
    .join("\n");

  const prompt = `The user was asked: "${question ?? "Which option?"}"

Available options:
${choicesText}

User's response: "${trimmed}"

Which option (1-${choices.length}) best matches what the user meant? Use semantic reasoning: "the first one", "search", "click continue", "I'll try the search box" etc. all map to the matching option.
Return ONLY a JSON object: {"selectedIndex": N} where N is 1-based, or {"selectedIndex": null} if no clear match.`;

  const content = buildContentParts(prompt);
  const rawText = await chatCompletion(config.summarizerModel, content, {
    maxTokens: 80,
    disableThinking: true,
  });
  const text = stripThinkTags(rawText);
  try {
    const parsed = JSON.parse(text.replace(/.*?(\{[\s\S]*\}).*/, "$1"));
    const n = parsed?.selectedIndex;
    if (typeof n === "number" && n >= 1 && n <= choices.length) {
      logMain("llm", "resolveUserChoiceToIndex", { answer: trimmed.slice(0, 40), selectedIndex: n });
      return n;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}


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

const SEMANTIC_TTL_MS = 8000;
const PLAN_TTL_MS = 1500;
const SAFETY_TTL_MS = 8000;
const SUMMARY_TTL_MS = 8000;
const SEMANTIC_MAX_TOKENS = 500;
const PLAN_MAX_TOKENS = 500;
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
    .map(({ el }) => `${el.id} | ${el.tag} | ${el.role ?? "-"} | ${el.text || el.ariaLabel || "-"}`);

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
  const fragment = text.slice(start);
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
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
    if (ch === "}") braceDepth -= 1;
    if (ch === "[") bracketDepth += 1;
    if (ch === "]") bracketDepth -= 1;
  }
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

async function chatCompletion(
  model: string,
  content: Array<{ type: "text"; text: string }>,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    disableThinking?: boolean;
  },
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content }],
    max_tokens: opts?.maxTokens,
    temperature: opts?.temperature ?? 0.1,
    response_format: opts?.jsonMode ? { type: "json_object" } : undefined,
    extra_body: opts?.disableThinking
      ? { chat_template_kwargs: { enable_thinking: false } }
      : undefined,
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
  inferredGoal: z.string(),
  plan: z.string(),
  planSteps: z
    .array(z.string())
    .optional()
    .transform((v) => v?.filter((s) => s.trim().length > 0) ?? []),
  searchQuery: z.string().optional(),
  clarifyingQuestion: z.preprocess(
    (v) => (typeof v === "string" ? v : undefined),
    z.string().optional(),
  ),
  choices: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(z.object({ label: z.string(), goal: z.string() })),
  ),
});

export type InferIntentResult = z.infer<typeof intentSchema>;

/** Infer user intent and create a plan before taking action. Call for every user prompt. */
export async function inferIntent(rawGoal: string): Promise<InferIntentResult> {
  logMain("llm", "inferIntent start", { rawGoalLen: rawGoal.length });
  const model = config.summarizerModel;
  const prompt = `You are an intent inference system. For the user's raw message, think deeply and thoroughly about what they actually want to do.
Resolve ambiguities, infer context, and produce a clear operational goal plus a step-by-step plan.

Return ONLY a JSON object with:
- inferredGoal: A clear, actionable goal statement (what the user wants to achieve)
- plan: A numbered step-by-step plan (what to do first, second, etc.). Be specific. Include search terms, sites, or actions when inferable.
- planSteps: Array of step strings, one per step. E.g. ["Search for Form 1040-SR on Google", "Click IRS.gov link", "Download PDF"]. Each step is a single actionable task.
- searchQuery: (optional) If the first step involves a web search, the SHORT query to type (e.g. "Form 1040-SR" or "IRS Form 1040-SR PDF"). Never the full goal or plan text. Max 80 chars.
- clarifyingQuestion: (optional) If the intent is ambiguous, one short question to help the user refine (e.g. "Do you want theater showtimes, streaming recommendations, or both?")
- choices: (optional) Array of 0-3 alternative interpretations when ambiguous. Each: { "label": "Short button label", "goal": "Full goal for this option" }

Examples:
- "download IRS Form 1040-SR" -> inferredGoal: "Find and download IRS Form 1040-SR", plan: "1. Search for Form 1040-SR 2. Click IRS link 3. Download PDF", planSteps: ["Search for Form 1040-SR on Google", "Click IRS.gov link in results", "Download PDF from form page"], searchQuery: "IRS Form 1040-SR PDF"
- "i wanna see a movie" -> inferredGoal: "Find movie recommendations", plan: "1. Search for movie recommendations 2. Present options", searchQuery: "movie recommendations"
- "book flight to tokyo" -> inferredGoal: "Book a flight to Tokyo", plan: "1. Navigate to flight search 2. Enter Tokyo 3. Select dates 4. Search", searchQuery: "flights to Tokyo"

User message:
${rawGoal}`;

  const content = buildContentParts(prompt);
  const text = await chatCompletion(model, content, {
    maxTokens: 520,
    jsonMode: true,
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
    inferredGoalLen: parsed.inferredGoal.length,
    planLen: parsed.plan.length,
    planSteps: parsed.planSteps?.length ?? 0,
    choices: parsed.choices?.length ?? 0,
  });
  return parsed;
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
      const slimText = observation.mainText.slice(0, 2600);
      const prioritizedElements = prioritizeElements(observation, userGoal, 40);
      const prompt = `
You are the Semantic Interpreter ("Eyes"). Convert raw page data into a simplified JSON schema of actions.
Output ONLY a single JSON object—no think tags, no markdown, no commentary.
Given the user's goal, return ONLY the TOP 3-5 actions that directly help the goal.
Never include options that are page-generic but not relevant to the user goal.
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
      const slimText = observation.mainText.slice(0, 2200);
      const prompt = `
You are an accessibility assistant for senior users.
Given page data, return STRICT JSON with keys: summary, purpose, choices[].
Each choice item must include label, rationale, suggestedAction. Include elementId when you can map to an element.
Keep language plain and short.

Page title: ${observation.title}
Page URL: ${observation.url}
Visible text:
${slimText}

Interactive elements (id + text + role):
${observation.elements
  .slice(0, 40)
  .map((el) => `${el.id} | ${el.tag} | ${el.role ?? "-"} | ${el.text || el.ariaLabel || "-"}`)
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
  const cacheKey = hashString(
    `${plannerModel}::${input.goal.slice(0, 260)}::${input.observation.url}::${input.currentStep ?? ""}::${timelineTail}::${numberedActions}::${numberedMcpTools}`,
  );

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
Be concise. Reasoning should be one short sentence.

CRITICAL: Do NOT return done=true until the user's goal is FULLY achieved.
- Navigating to a site is NEVER completion. You must fill forms, click buttons, search, etc.
- For "book a flight SFO to MUM tomorrow": you must navigate to a flight search page (e.g. google.com/travel/flights), fill origin SFO, destination MUM/BOM, date tomorrow, click search. Only done when search results are shown or user has selected a flight.
- One action per step. Keep going until the goal is achieved.

ACTION SOURCE OF TRUTH:
- Prefer ONLY the numbered semantic options below.
- If options exist, return selectedChoiceIndex (1-based) instead of raw action.
- If user says "option N", pick that exact valid index when possible.
- Return raw action only when there are zero executable semantic options.

MCP TOOL USE:
- Use MCP tools when browser actions cannot directly obtain required external data or perform non-UI tasks.
- If using MCP tool, return mcpToolCall with {server, name, arguments}.
- Do not call MCP tools for actions already available as executable sidebar browser options.

GOOGLE SEARCH: When on google.com and the user wants to search, type ONLY a short search query (e.g. "Form 1040-SR" or "flights to Tokyo") into the main search box. NEVER type the full goal, plan, or "Inferred goal:" text. Use the search query from the goal context. Pick the choice whose actionValue is the short query.

User goal: ${input.goal}
Current URL: ${input.observation.url}
Current title: ${input.observation.title}
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

If semantic options exist, return:
{"done": false, "reasoning": "...", "confidence": 0.85, "expectedOutcome": "...", "selectedChoiceIndex": 2}

If MCP tool is needed, return:
{"done": false, "reasoning": "...", "confidence": 0.85, "expectedOutcome": "...", "mcpToolCall": {"server": "serverName", "name": "toolName", "arguments": {}}}

Only if no executable semantic options exist, return ONE raw action:
{"done": false, "reasoning": "...", "confidence": 0.85, "expectedOutcome": "...", "action": {"type": "click"|"type"|"select"|"scroll"|"navigate", ...}}
`;

      const content = buildContentParts(prompt);
      const maxTokens = config.turboMode ? PLAN_MAX_TOKENS : 360;
      let text = await chatCompletion(plannerModel, content, {
        maxTokens,
        disableThinking: true,
        jsonMode: true,
      });
      logModelResponse("planAction raw response", text, 900);
      let parsed: PlanActionResult;
      try {
        parsed = actionSchema.parse(extractJson(text));
      } catch (e) {
        if (maxTokens < 512) {
          logMain("llm", "planAction parse failed, retrying with higher max_tokens", {
            error: String(e),
          });
          text = await chatCompletion(plannerModel, content, {
            maxTokens: 512,
            disableThinking: true,
            jsonMode: true,
          });
          logModelResponse("planAction retry raw response", text, 900);
          parsed = actionSchema.parse(extractJson(text));
        } else {
          throw e;
        }
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


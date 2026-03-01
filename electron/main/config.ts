import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { logMain } from "../../shared/logger";

loadEnv();

const envSchema = z.object({
  VLLM_BASE_URL: z.string().url(),
  VLLM_API_KEY: z.string().min(1),
  STEADYHANDS_PLANNER_MODEL: z.string().min(1),
  STEADYHANDS_SUMMARIZER_MODEL: z.string().min(1),
  STEADYHANDS_MAX_STEPS: z.coerce.number().int().positive(),
  STEADYHANDS_AGENT_MODE_DEFAULT: z.enum(["manual", "assist", "auto"]),
  STEADYHANDS_OBSERVE_TEXT_LIMIT: z.coerce.number().int().positive(),
  STEADYHANDS_ACTION_TIMEOUT_MS: z.coerce.number().int().positive(),
  STEADYHANDS_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive(),
  STEADYHANDS_MAX_RETRIES_PER_STEP: z.coerce.number().int().nonnegative(),
  STEADYHANDS_FAST_MODE: z.enum(["true", "false"]).optional().default("true"),
  STEADYHANDS_ENABLE_SAFETY_GUARDRAILS: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  STEADYHANDS_ENABLE_COORDINATE_FALLBACK: z.enum(["true", "false"]),
  STEADYHANDS_ENABLE_AUTO_HIGHLIGHT: z.enum(["true", "false"]),
  STEADYHANDS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  STEADYHANDS_REQUIRE_APPROVAL_FOR_RISKY_ACTIONS: z.enum(["true", "false"]),
  STEADYHANDS_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1),
  STEADYHANDS_LOG_LLM_RAW: z.enum(["true", "false"]).optional().default("false"),
  STEADYHANDS_FAST_PLANNER_MODEL: z.string().min(1).optional(),
  STEADYHANDS_TURBO_MODE: z.enum(["true", "false"]).optional().default("true"),
  STEADYHANDS_MCP_SERVERS: z.string().optional(),
  ELEVEN_LABS_API_KEY: z.string().optional(),
});

const mcpServerConfigSchema = z.object({
  transport: z.enum(["stdio", "http"]).optional().default("stdio"),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.transport === "http") {
    if (!value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url is required when transport is http",
        path: ["url"],
      });
    }
    return;
  }
  if (!value.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "command is required when transport is stdio",
      path: ["command"],
    });
  }
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export type AppConfig = {
  vllmBaseUrl: string;
  vllmApiKey: string;
  plannerModel: string;
  summarizerModel: string;
  maxSteps: number;
  defaultAgentMode: "manual" | "assist" | "auto";
  observeTextLimit: number;
  actionTimeoutMs: number;
  verifyTimeoutMs: number;
  maxRetriesPerStep: number;
  fastMode: boolean;
  enableSafetyGuardrails: boolean;
  enableCoordinateFallback: boolean;
  enableAutoHighlight: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  requireApprovalForRiskyActions: boolean;
  confidenceThreshold: number;
  logLlmRaw: boolean;
  fastPlannerModel?: string;
  turboMode: boolean;
  mcpServers: Record<string, McpServerConfig>;
  elevenLabsApiKey?: string;
};

let cachedConfig: AppConfig | null = null;

function assertModelId(model: string, key: string): string {
  const allowedPattern = /^[A-Za-z0-9._\-/:]+$/;
  if (!allowedPattern.test(model)) {
    throw new Error(`Invalid model id for ${key}: ${model}`);
  }
  return model;
}

function parseMcpServers(raw: string | undefined): Record<string, McpServerConfig> {
  if (!raw || !raw.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid STEADYHANDS_MCP_SERVERS JSON: ${
        error instanceof Error ? error.message : "Unknown parse error"
      }`,
    );
  }

  const envelopeSchema = z.record(z.string(), mcpServerConfigSchema);
  return envelopeSchema.parse(parsed);
}

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    logMain("config", "Validation failed", { details });
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;
  logMain("config", "Env parsed successfully");
  cachedConfig = {
    vllmBaseUrl: env.VLLM_BASE_URL,
    vllmApiKey: env.VLLM_API_KEY,
    plannerModel: assertModelId(
      env.STEADYHANDS_PLANNER_MODEL,
      "STEADYHANDS_PLANNER_MODEL",
    ),
    summarizerModel: assertModelId(
      env.STEADYHANDS_SUMMARIZER_MODEL,
      "STEADYHANDS_SUMMARIZER_MODEL",
    ),
    maxSteps: env.STEADYHANDS_MAX_STEPS,
    defaultAgentMode: env.STEADYHANDS_AGENT_MODE_DEFAULT,
    observeTextLimit: env.STEADYHANDS_OBSERVE_TEXT_LIMIT,
    actionTimeoutMs: env.STEADYHANDS_ACTION_TIMEOUT_MS,
    verifyTimeoutMs: env.STEADYHANDS_VERIFY_TIMEOUT_MS,
    maxRetriesPerStep: env.STEADYHANDS_MAX_RETRIES_PER_STEP,
    fastMode: env.STEADYHANDS_FAST_MODE === "true",
    enableSafetyGuardrails: env.STEADYHANDS_ENABLE_SAFETY_GUARDRAILS === "true",
    enableCoordinateFallback: env.STEADYHANDS_ENABLE_COORDINATE_FALLBACK === "true",
    enableAutoHighlight: env.STEADYHANDS_ENABLE_AUTO_HIGHLIGHT === "true",
    logLevel: env.STEADYHANDS_LOG_LEVEL,
    requireApprovalForRiskyActions:
      env.STEADYHANDS_REQUIRE_APPROVAL_FOR_RISKY_ACTIONS === "true",
    confidenceThreshold: env.STEADYHANDS_CONFIDENCE_THRESHOLD,
    logLlmRaw: env.STEADYHANDS_LOG_LLM_RAW === "true",
    fastPlannerModel: env.STEADYHANDS_FAST_PLANNER_MODEL
      ? assertModelId(
          env.STEADYHANDS_FAST_PLANNER_MODEL,
          "STEADYHANDS_FAST_PLANNER_MODEL",
        )
      : undefined,
    turboMode: env.STEADYHANDS_TURBO_MODE === "true",
    mcpServers: parseMcpServers(env.STEADYHANDS_MCP_SERVERS),
    elevenLabsApiKey: env.ELEVEN_LABS_API_KEY,
  };

  return cachedConfig;
}

export function getPublicConfig() {
  const c = getConfig();
  return {
    plannerModel: c.plannerModel,
    summarizerModel: c.summarizerModel,
    maxSteps: c.maxSteps,
    defaultAgentMode: c.defaultAgentMode,
    observeTextLimit: c.observeTextLimit,
    actionTimeoutMs: c.actionTimeoutMs,
    verifyTimeoutMs: c.verifyTimeoutMs,
    maxRetriesPerStep: c.maxRetriesPerStep,
    fastMode: c.fastMode,
    enableSafetyGuardrails: c.enableSafetyGuardrails,
    requireApprovalForRiskyActions: c.requireApprovalForRiskyActions,
    enableAutoHighlight: c.enableAutoHighlight,
    logLevel: c.logLevel,
    confidenceThreshold: c.confidenceThreshold,
  };
}

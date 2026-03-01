const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../.test-build/electron/main/config.js");
const originalEnv = { ...process.env };

const validEnv = {
  VLLM_BASE_URL: "http://localhost:8000/v1",
  VLLM_API_KEY: "unit-test-key",
  STEADYHANDS_PLANNER_MODEL: "Qwen3-30B-A3B",
  STEADYHANDS_SUMMARIZER_MODEL: "Qwen3-30B-A3B",
  STEADYHANDS_MAX_STEPS: "12",
  STEADYHANDS_AGENT_MODE_DEFAULT: "auto",
  STEADYHANDS_OBSERVE_TEXT_LIMIT: "8000",
  STEADYHANDS_ACTION_TIMEOUT_MS: "4000",
  STEADYHANDS_VERIFY_TIMEOUT_MS: "5000",
  STEADYHANDS_MAX_RETRIES_PER_STEP: "2",
  STEADYHANDS_FAST_MODE: "true",
  STEADYHANDS_ENABLE_COORDINATE_FALLBACK: "true",
  STEADYHANDS_ENABLE_AUTO_HIGHLIGHT: "false",
  STEADYHANDS_LOG_LEVEL: "info",
  STEADYHANDS_REQUIRE_APPROVAL_FOR_RISKY_ACTIONS: "false",
  STEADYHANDS_CONFIDENCE_THRESHOLD: "0.65",
};

function resetProcessEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

function loadFreshConfigModule() {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test.beforeEach(() => {
  resetProcessEnv();
  Object.assign(process.env, validEnv);
});

test.afterEach(() => {
  resetProcessEnv();
  delete require.cache[require.resolve(modulePath)];
});

test("getConfig parses and coerces all config values", () => {
  const { getConfig, getPublicConfig } = loadFreshConfigModule();
  const config = getConfig();

  assert.equal(config.vllmBaseUrl, validEnv.VLLM_BASE_URL);
  assert.equal(config.vllmApiKey, validEnv.VLLM_API_KEY);
  assert.equal(config.plannerModel, validEnv.STEADYHANDS_PLANNER_MODEL);
  assert.equal(config.summarizerModel, validEnv.STEADYHANDS_SUMMARIZER_MODEL);
  assert.equal(config.maxSteps, 12);
  assert.equal(config.defaultAgentMode, "auto");
  assert.equal(config.observeTextLimit, 8000);
  assert.equal(config.actionTimeoutMs, 4000);
  assert.equal(config.verifyTimeoutMs, 5000);
  assert.equal(config.maxRetriesPerStep, 2);
  assert.equal(config.fastMode, true);
  assert.equal(config.enableSafetyGuardrails, false);
  assert.equal(config.enableCoordinateFallback, true);
  assert.equal(config.enableAutoHighlight, false);
  assert.equal(config.logLevel, "info");
  assert.equal(config.requireApprovalForRiskyActions, false);
  assert.equal(config.confidenceThreshold, 0.65);

  const publicConfig = getPublicConfig();
  assert.deepEqual(publicConfig, {
    plannerModel: validEnv.STEADYHANDS_PLANNER_MODEL,
    summarizerModel: validEnv.STEADYHANDS_SUMMARIZER_MODEL,
    maxSteps: 12,
    defaultAgentMode: "auto",
    observeTextLimit: 8000,
    actionTimeoutMs: 4000,
    verifyTimeoutMs: 5000,
    maxRetriesPerStep: 2,
    fastMode: true,
    enableSafetyGuardrails: false,
    requireApprovalForRiskyActions: false,
    enableAutoHighlight: false,
    logLevel: "info",
    confidenceThreshold: 0.65,
  });
});

test("getConfig rejects invalid model ids", () => {
  process.env.STEADYHANDS_PLANNER_MODEL = "bad model with spaces";
  const { getConfig } = loadFreshConfigModule();

  assert.throws(() => getConfig(), /Invalid model id for STEADYHANDS_PLANNER_MODEL/);
});

test("getConfig rejects out-of-range confidence thresholds", () => {
  process.env.STEADYHANDS_CONFIDENCE_THRESHOLD = "1.2";
  const { getConfig } = loadFreshConfigModule();

  assert.throws(
    () => getConfig(),
    /Invalid environment configuration:\nSTEADYHANDS_CONFIDENCE_THRESHOLD:/,
  );
});

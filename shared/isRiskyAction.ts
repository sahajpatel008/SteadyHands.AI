import type { BrowserAction } from "./types";

/** Actions that require HITL confirmation (payment, checkout, etc.) */
export function isRiskyAction(action: BrowserAction): boolean {
  const s = JSON.stringify(action).toLowerCase();
  return (
    /\$|pay|payment|confirm|transfer|withdraw|submit.*order|purchase|buy now/i.test(s) ||
    (action.type === "navigate" && /checkout|payment|pay\./i.test(action.url))
  );
}

/** Actions to stop before—never proceed. Auth, login, payment, or strict user info. */
export function isStopAction(
  action: BrowserAction,
  /** Optional label/suggestedAction from the choice (e.g. "Login", "Sign in") */
  choiceContext?: string,
): boolean {
  const s = JSON.stringify(action).toLowerCase();
  const url = action.type === "navigate" ? action.url.toLowerCase() : "";
  const text = action.type === "type" ? (action.text || "").toLowerCase() : "";
  const ctx = (choiceContext || "").toLowerCase();

  const authLogin =
    /\b(login|sign\s*in|signin|sign\s*up|signup|logout|authenticate|auth)\b/i.test(s) ||
    /\b(login|sign\s*in|signin|sign\s*up|signup|logout|authenticate)\b/i.test(ctx) ||
    /\/login|\/signin|\/auth|\/account\b/i.test(url);

  const payment =
    /\$|pay|payment|checkout|purchase|transfer|withdraw|credit\s*card|cvv|billing/i.test(s) ||
    /\b(pay|payment|checkout|purchase|buy|transfer)\b/i.test(ctx) ||
    /checkout|payment|pay\.|cart|billing/i.test(url);

  const userInfo =
    /\b(password|passwd|ssn|social\s*security|credit\s*card|cvv|cvc|pin\b)/i.test(s) ||
    /\b(password|secret|credential)\b/i.test(text) ||
    /\b(password|credential)\b/i.test(ctx);

  return authLogin || payment || userInfo;
}

import type { BrowserAction } from "./types";

export function isRiskyAction(action: BrowserAction): boolean {
  const s = JSON.stringify(action).toLowerCase();
  return (
    /\$|pay|payment|confirm|transfer|withdraw|submit.*order|purchase|buy now/i.test(s) ||
    (action.type === "navigate" && /checkout|payment|pay\./i.test(action.url))
  );
}

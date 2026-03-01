import type { BrowserAction, SidebarChoice } from "../../shared/types";

export function choiceToAction(choice: SidebarChoice): BrowserAction | null {
  const actionType = choice.actionType;
  if (!actionType) return null;

  if (actionType === "navigate") {
    const url = choice.actionValue?.trim();
    return url ? { type: "navigate", url } : null;
  }

  const elementId = choice.elementId?.trim();
  if (!elementId) return null;

  if (actionType === "click") return { type: "click", elementId };
  if (actionType === "scroll") return { type: "scroll", elementId };
  if (actionType === "type") {
    const text = choice.actionValue ?? "";
    return { type: "type", elementId, text };
  }
  if (actionType === "select") {
    const value = choice.actionValue?.trim();
    return value ? { type: "select", elementId, value } : null;
  }

  return null;
}

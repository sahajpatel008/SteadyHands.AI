import type { BrowserAction } from "../../shared/types";

type ActionFallbackHint = {
  text?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  tag?: string | null;
  role?: string | null;
  href?: string | null;
  type?: string | null;
};

export function getActionScript(
  action: BrowserAction,
  enableHighlight: boolean,
  fallbackHint?: ActionFallbackHint | null,
): string {
  const payload = JSON.stringify(action);
  const hintPayload = JSON.stringify(fallbackHint ?? null);
  return `
(() => {
  const action = ${payload};
  const hint = ${hintPayload};
  const findById = (id) => document.querySelector('[data-sh-id="' + id + '"]');
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const findFallback = (id) => {
    const elements = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role='button'],[role='link']"));
    return elements.find((el) => clean(el.getAttribute("data-sh-id")) === id) || null;
  };

  const tokenize = (text) =>
    clean(text)
      .toLowerCase()
      .split(/\\s+/)
      .filter((t) => t.length >= 3)
      .slice(0, 8);

  const scoreCandidate = (el) => {
    if (!(el instanceof HTMLElement)) return 0;
    const haystack = [
      clean(el.innerText || el.textContent || ""),
      clean(el.getAttribute("aria-label")),
      clean(el.getAttribute("placeholder")),
      clean(el.getAttribute("value")),
      clean(el.getAttribute("title")),
      clean(el.getAttribute("name")),
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    if (hint?.tag && el.tagName.toLowerCase() === String(hint.tag).toLowerCase()) score += 2;
    if (hint?.role && clean(el.getAttribute("role")).toLowerCase() === String(hint.role).toLowerCase()) score += 2;
    if (hint?.type && clean(el.getAttribute("type")).toLowerCase() === String(hint.type).toLowerCase()) score += 1;
    if (hint?.href && "href" in el && String(el.getAttribute("href") || "").includes(String(hint.href))) score += 2;

    const hintTokens = [
      ...tokenize(hint?.text || ""),
      ...tokenize(hint?.ariaLabel || ""),
      ...tokenize(hint?.placeholder || ""),
    ];
    for (const token of hintTokens) {
      if (haystack.includes(token)) score += 2;
    }

    if (action.type === "type") {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) score += 2;
      if (
        /google\\.com/.test(window.location.hostname) &&
        (haystack.includes("search google") || haystack.includes("search"))
      ) {
        score += 2;
      }
    }

    return score;
  };

  const findSemanticFallback = () => {
    const pool = Array.from(
      document.querySelectorAll(
        "a,button,input:not([type='hidden']),select,textarea,[role='button'],[role='link'],[role='combobox']",
      ),
    );
    let best = null;
    let bestScore = 0;
    for (const candidate of pool) {
      const score = scoreCandidate(candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (!best || bestScore < 3) return null;
    return best;
  };

  const highlight = (el) => {
    if (!el || !${enableHighlight ? "true" : "false"}) return;
    const prev = el.style.outline;
    el.style.outline = "3px solid #ff5b24";
    setTimeout(() => {
      el.style.outline = prev;
    }, 700);
  };

  const locate = (id) => {
    const exact = findById(id);
    if (exact) return exact;
    const byAttr = findFallback(id);
    if (byAttr) return byAttr;
    return findSemanticFallback();
  };

  if (action.type === "navigate") {
    window.location.href = action.url;
    return { ok: true, message: "Navigating", action };
  }

  const target = locate(action.elementId);
  if (!target || !(target instanceof HTMLElement)) {
    return { ok: false, message: "Target element not found: " + action.elementId, action };
  }

  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  highlight(target);

  if (action.type === "click") {
    target.click();
    return { ok: true, message: "Clicked " + action.elementId, action };
  }

  if (action.type === "type") {
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      target.focus();
      target.value = action.text;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      if (/google\\.com/.test(window.location.hostname)) {
        const form = target.closest("form");
        if (form && typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        }
      }
      return { ok: true, message: "Typed into " + action.elementId + (/google\\.com/.test(window.location.hostname) ? " (Enter pressed)" : ""), action };
    }
    return { ok: false, message: "Target is not a text input", action };
  }

  if (action.type === "select") {
    if (target instanceof HTMLSelectElement) {
      target.value = action.value;
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, message: "Selected value on " + action.elementId, action };
    }
    return { ok: false, message: "Target is not a select element", action };
  }

  if (action.type === "scroll") {
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    return { ok: true, message: "Scrolled to " + action.elementId, action };
  }

  return { ok: false, message: "Unsupported action type", action };
})();
`;
}

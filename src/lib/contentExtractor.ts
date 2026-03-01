export function getExtractionScript(textLimit: number): string {
  return `
(() => {
  const cleanText = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    let p = el.parentElement;
    while (p) {
      const ps = getComputedStyle(p);
      if (ps.display === "none" || ps.visibility === "hidden") return false;
      p = p.parentElement;
    }
    return true;
  };
  const interactiveSelector = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  const candidates = Array.from(document.querySelectorAll(interactiveSelector));
  const elements = [];
  let index = 0;

  const url = (typeof window !== "undefined" && window.location?.href) || "";
  const isGoogleHome =
    /^https?:\\/\\/(www\\.)?google\\.com\\/?([#?]|$)/i.test(url) &&
    !url.includes("/search");

  for (const node of candidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (!isVisible(node)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    if (isGoogleHome) {
      const tag = node.tagName.toLowerCase();
      const name = node.getAttribute("name");
      const type = node instanceof HTMLInputElement ? node.type : null;
      const isSearchInput =
        (tag === "textarea" || tag === "input") && name === "q";
      const isGoogleSearchBtn =
        tag === "input" && type === "submit" && name === "btnK";
      if (!isSearchInput && !isGoogleSearchBtn) continue;
    }

    const id = "sh-" + index++;
    node.setAttribute("data-sh-id", id);

    const item = {
      id,
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute("role"),
      text: cleanText(node.innerText || node.textContent || ""),
      ariaLabel: node.getAttribute("aria-label"),
      href: node instanceof HTMLAnchorElement ? node.href : null,
      type: node instanceof HTMLInputElement ? node.type : null,
      placeholder: "placeholder" in node ? node.getAttribute("placeholder") : null,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
    elements.push(item);
  }

  const headingEls = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter((el) => isVisible(el)).slice(0, 20);
  const headings = headingEls.map((el) => {
    const level = parseInt(el.tagName.charAt(1), 10);
    const t = cleanText(el.innerText || el.textContent || "");
    return (level === 1 ? "H1: " : "H" + level + ": ") + t.slice(0, 120);
  }).join("\\n");

  const bodyText = cleanText(document.body?.innerText || "").slice(0, ${textLimit});
  const pageStructure = headings ? "[Page structure]\\n" + headings + "\\n\\n[Content]\\n" : "";
  return {
    title: document.title || "Untitled",
    url: window.location.href,
    mainText: pageStructure + bodyText,
    elements
  };
})();
`;
}

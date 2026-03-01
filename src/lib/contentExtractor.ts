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

  for (const node of candidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (!isVisible(node)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

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

  const bodyText = cleanText(document.body?.innerText || "").slice(0, ${textLimit});
  return {
    title: document.title || "Untitled",
    url: window.location.href,
    mainText: bodyText,
    elements
  };
})();
`;
}

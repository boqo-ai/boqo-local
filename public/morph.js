// Patch the DOM in place instead of replacing it: unchanged elements are kept, so running
// animations (spinners, the live dot), playing videos, focus and scroll positions survive
// a refresh. Elements with data-keep are never touched once they exist.
export function morph(el, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  syncChildren(el, tpl.content);
}

function syncChildren(a, b) {
  const an = [...a.childNodes], bn = [...b.childNodes];
  for (let i = 0; i < bn.length; i++) {
    const x = an[i], y = bn[i];
    if (!x) { a.appendChild(y.cloneNode(true)); continue; }
    if (x.nodeType !== y.nodeType || (x.nodeType === 1 && (x.tagName !== y.tagName || x.dataset.key !== y.dataset.key))) {
      a.replaceChild(y.cloneNode(true), x);
      continue;
    }
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    if (x.hasAttribute("data-keep")) continue;
    // `style` is never in the templates (the CSP refuses inline styles); one on the page was set at runtime through
    // the CSSOM (the chat box's auto-grow, setBars), so a refresh keeps it.
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name) && at.name !== "style") x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    if (x.tagName === "TEXTAREA" || x.tagName === "INPUT") continue; // never overwrite what the person is typing
    if (!x.isEqualNode(y)) syncChildren(x, y);
  }
  for (let i = an.length - 1; i >= bn.length; i--) a.removeChild(an[i]);
}

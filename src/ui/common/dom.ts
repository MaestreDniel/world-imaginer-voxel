/** Creates an element with an optional class name and text; empty strings set nothing (SP2b spec §1.5). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== '') e.className = className;
  if (text !== '') e.textContent = text;
  return e;
}

/** All protocol content enters the DOM through textContent or control values. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const text = (value: unknown): string => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
export function field(label: string, control: HTMLElement): HTMLLabelElement {
  const labelNode = element("label"); labelNode.append(element("span", label), control); return labelNode;
}

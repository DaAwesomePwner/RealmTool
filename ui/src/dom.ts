export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(text: string, action: () => void): HTMLButtonElement {
  const node = el('button', text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed. Please try again.';
}

export function textValue(value: unknown): string {
  if (value === null || value === undefined) return 'Unknown';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export const create = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { id?: string; className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (options.id !== undefined) {
    element.id = options.id;
  }
  if (options.className !== undefined) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  return element;
};

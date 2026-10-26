export function replaceAuto(text, name, content) {
  const open = `<!-- vf:auto:${name} -->`;
  const close = `<!-- /vf:auto:${name} -->`;
  const block = `${open}\n${content}\n${close}`;
  const a = text.indexOf(open);
  const b = a < 0 ? -1 : text.indexOf(close, a + open.length);
  if (a < 0 || b < 0) return `${text.replace(/\n*$/, "\n")}\n${block}\n`;
  return text.slice(0, a) + block + text.slice(b + close.length);
}

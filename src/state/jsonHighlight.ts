export type JsonToken = { type: 'key' | 'string' | 'number' | 'literal' | 'punctuation' | 'plain'; text: string };

/** A tolerant lexer keeps partially typed JSON editable without executing or interpreting its contents. */
export function highlightJson(source: string): JsonToken[] {
  const pattern = /"(?:[^"\\\r\n]|\\[^\r\n])*(?:"|(?=\r?$))|-?\d+(?:\.\d*)?(?:[eE][+-]?\d*)?|\b(?:true|false|null)\b|[{}\[\]:,]/gm;
  const tokens: JsonToken[] = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index!;
    if (start > offset) tokens.push({ type: 'plain', text: source.slice(offset, start) });
    const text = match[0];
    const type: JsonToken['type'] = text[0] === '"' ? /^\s*:/.test(source.slice(start + text.length)) ? 'key' : 'string'
      : /^-?\d/.test(text) ? 'number' : /^(true|false|null)$/.test(text) ? 'literal' : 'punctuation';
    tokens.push({ type, text }); offset = start + text.length;
  }
  if (offset < source.length) tokens.push({ type: 'plain', text: source.slice(offset) });
  return tokens;
}

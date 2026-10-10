/**
 * remark-math 解析 $ / $$；模型也常返回 LaTeX 的 \( / \[ 定界符。
 * 在 Markdown 吞掉这些反斜杠前，仅为展示转换完整公式。存储和复制仍使用原回复。
 */
export function normalizeAssistantMath(source: string): string {
  if ((!source.includes('\\(') && !source.includes('\\['))
      || (!source.includes('\\)') && !source.includes('\\]'))) return source;
  const output: string[] = [];
  let plain = '';
  let fence: { character: string; length: number } | null = null;
  const flush = () => { output.push(normalizeMathText(plain)); plain = ''; };
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    // 包括列表/引用内的代码围栏；缩进代码同样不能被当成数学公式改写。
    const marker = line.match(/^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)/);
    if (fence) {
      output.push(line);
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      flush();
      output.push(line);
      fence = { character: marker[1][0], length: marker[1].length };
    } else plain += line;
  }
  flush();
  return output.join('');
}

/** 查找未被额外反斜杠转义的闭合符；未闭合公式原样等待后续流式文本。 */
function closingAt(text: string, delimiter: string, start: number): number {
  let index = text.indexOf(delimiter, start);
  while (index !== -1) {
    let slashes = 0;
    for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous--) slashes++;
    if (slashes % 2 === 0) return index;
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}

function normalizeMathText(text: string): string {
  const output: string[] = [];
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    // 在完整公式外保护缩进代码。公式已从开头一次匹配到结尾，所以其中的缩进行
    // 仍属于公式（例如多行 aligned），不会被拆成普通代码。
    const indented = (index === 0 || text[index - 1] === '\n') ? rest.match(/^(?: {4}|\t)[^\n]*(?:\n|$)/) : null;
    if (indented) { output.push(indented[0]); index += indented[0].length; continue; }
    // 链接目标/自动链接不是公式；保留转义与 URL 字节，不改变普通 Markdown 链接。
    const link = rest.match(/^(?:!?\[[^\]\n]*\]\((?:\\.|[^)\n])*\)|<[^>\n]+>)/);
    if (link) { output.push(link[0]); index += link[0].length; continue; }
    const ticks = rest.match(/^`+/)?.[0];
    if (ticks) {
      let end = text.indexOf(ticks, index + ticks.length);
      while (end !== -1 && (text[end - 1] === '`' || text[end + ticks.length] === '`')) end = text.indexOf(ticks, end + ticks.length);
      if (end !== -1) { output.push(text.slice(index, end + ticks.length)); index = end + ticks.length; continue; }
      output.push(ticks); index += ticks.length; continue;
    }
    // 已有 $ / $$ 公式不再转换其内部定界符，防止二次处理破坏 \text 等内容。
    const dollars = rest.match(/^\${1,2}(?!\$)/)?.[0];
    if (dollars) {
      const end = closingAt(text, dollars, index + dollars.length);
      if (end !== -1) { output.push(text.slice(index, end + dollars.length)); index = end + dollars.length; continue; }
    }
    if (text[index] === '\\') {
      const opening = text[index + 1];
      if (opening === '(' || opening === '[') {
        const close = `\\${opening === '(' ? ')' : ']'}`;
        const end = closingAt(text, close, index + 2);
        if (end !== -1) {
          const body = text.slice(index + 2, end).trim();
          if (body) {
            const prefix = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
            // 表格/引用中的公式保留所在结构，不用插入空行破坏行或引用层级。
            const inline = opening === '(' || /\||^\s*>/.test(prefix);
            output.push(inline ? `$${body}$` : `\n\n$$\n${body}\n$$\n\n`);
            index = end + close.length;
            continue;
          }
        }
      }
      // 成对复制其他转义（尤其是 \\[ 字面值），不从第二个反斜杠重新匹配。
      output.push(text.slice(index, index + 2)); index += 2; continue;
    }
    output.push(text[index]); index++;
  }
  return output.join('');
}

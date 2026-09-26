/** Display-only repairs. Never change stored replies or Markdown copied by users. */
const shellLanguage = '(?:bash|sh|shell|zsh|powershell|pwsh)';
const shellCommand = '(?:sudo|docker|podman|mc|kubectl|helm|git|npm|pnpm|yarn|curl|wget|echo|printf|cat|ls|cd|pwd|grep|find|tail|systemctl|journalctl|alias|export|apt|yum|dnf)';

function misplacedCommand(info: string): { language: string; body: string } | null {
  // Only split recognizable shell instructions. Unknown language labels and
  // legitimate fence metadata must remain unchanged; never guess command lines.
  const match = info.match(new RegExp(`^(${shellLanguage})[ \\t]*(${shellCommand}(?:[ \\t].*|$))$`));
  return match ? { language: match[1], body: match[2] } : null;
}

export function prepareAssistantMarkdown(source: string): string {
  const lines = source.split('\n');
  const output: string[] = [];
  let fence: { character: string; length: number; repaired: boolean } | undefined;
  for (const line of lines) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/);
      if (close && close[1][0] === fence.character && close[1].length >= fence.length) {
        output.push(line); fence = undefined; continue;
      }
      // A repaired opening can also have a closing fence stuck to its last line.
      // Leave all content inside originally valid fences untouched (heredocs,
      // Markdown examples, shell comments, quotes, indentation and escapes).
      const stuckClose = fence.repaired && line.match(/^(.*\S)(`{3,}|~{3,})[ \t]*$/);
      if (stuckClose && stuckClose[2][0] === fence.character && stuckClose[2].length >= fence.length) {
        output.push(stuckClose[1], stuckClose[2]); fence = undefined; continue;
      }
      output.push(line); continue;
    }

    // A heading with Chinese text or a numbered step is unambiguous enough to
    // tolerate a missing separator. Do not reinterpret hashtags or shebangs.
    const heading = line.replace(/^( {0,3}#{1,6})(?=[\p{Script=Han}\d])/u, '$1 ');
    const compact = heading.match(/^(.*?)(`{3,})([^`]+)\2[ \t]*$/);
    if (compact && !compact[1].includes('`')) {
      const command = misplacedCommand(compact[3]);
      const language = compact[3].match(/^(text|plaintext|json|yaml|javascript|typescript|python|sql)[ \t]+(.+)$/);
      const recovered = command ?? (language ? { language: language[1], body: language[2] } : null);
      if (recovered) {
        if (compact[1].trim()) output.push(compact[1].trimEnd(), '');
        output.push(`${compact[2]}${recovered.language}`, recovered.body, compact[2]);
        continue;
      }
    }
    const opening = heading.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[2][0] === '`' && opening[3].includes('`'))) {
      const command = misplacedCommand(opening[3]);
      fence = { character: opening[2][0], length: opening[2].length, repaired: !!command };
      output.push(command ? `${opening[1]}${opening[2]}${command.language}\n${command.body}` : heading);
    } else output.push(heading);
  }
  return output.join('\n');
}

import type { ChatAgentActivity, ChatMessage, ChatToolActivity } from '../types';

// Tool output can itself contain Markdown fences. Use a longer outer fence so
// logs, commands and nested snippets remain intact when pasted into an editor.
function codeBlock(text: string, language = 'text'): string {
  const longestFence = (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 2);
  const fence = '`'.repeat(longestFence + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function toolToMarkdown(tool: ChatToolActivity): string {
  return [
    `### ${tool.name === 'executeCommand' ? '执行命令' : tool.name}`,
    tool.command ? codeBlock(tool.command, tool.name === 'executeCommand' ? 'sh' : 'text') : '',
    tool.output ? codeBlock(tool.output) : '',
  ].filter(Boolean).join('\n\n');
}

export function agentToMarkdown(agent: ChatAgentActivity): string {
  const text = agent.segments?.filter(segment => segment.type === 'text').map(segment => segment.text).join('') ?? '';
  const body = agent.segments?.length
    ? agent.segments.map(segment => segment.type === 'text' ? segment.text : toolToMarkdown(segment.tool))
    : agent.tools.map(toolToMarkdown);
  const finalOutput = agent.output && (!text.trim() || (agent.status === 'error' && !text.includes(agent.output))) ? agent.output : '';
  return [`### ${agent.name}`, agent.task, ...body, finalOutput].filter(Boolean).join('\n\n');
}

export function messageToMarkdown(message: ChatMessage): string {
  if (message.role === 'user') return message.text;
  if (message.segments?.length) {
    return message.segments.map(segment => segment.type === 'text' ? segment.text
      : segment.type === 'tool' ? toolToMarkdown(segment.tool) : agentToMarkdown(segment.agent)).join('\n\n');
  }
  return [message.text, message.summary, ...(message.tools ?? []).map(toolToMarkdown)].filter(Boolean).join('\n\n');
}

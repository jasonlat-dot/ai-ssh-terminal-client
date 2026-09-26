import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { prepareAssistantMarkdown } from '../src/state/assistantMarkdown.ts';
import { agentApi } from '../src/api/agent.ts';

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: prepareAssistantMarkdown(text) }));
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
async function streamed(wire: string, fragmentSize = 7) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'https://api.example.test' } });
  const bytes = new TextEncoder().encode(wire);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragmentSize) controller.enqueue(bytes.slice(i, i + fragmentSize));
    controller.close();
  } }));
  let text = '';
  await agentApi.chatStream({ agentId: 'a', userId: 'u', sessionId: 's', terminalSessionId: '', message: 'hello' }, event => {
    if (event.event === 'text' || event.event === 'agent_text') text += event.content;
  });
  return text;
}
const done = JSON.stringify({ event: 'done', content: '' });

test('JSON Lines retain every delta, newline, quote and escape across arbitrary UTF-8 chunks', async () => {
  const deltas = ['##', ' ', '进入容器', '\n\n', '```', 'bash', '\n', '  mc alias set local ', '"http://127.0.0.1:9000"', ' ', '"\\n"', '\n', 'mc ls local', '\n', '```'];
  const wire = deltas.map(content => JSON.stringify({ event: 'text', content })).join('\n') + '\n' + done + '\n';
  const text = await streamed(wire, 1);
  assert.equal(text, deltas.join(''));
  assert.match(render(text), /<h2>进入容器<\/h2>/);
  assert.match(render(text), /<pre><code class="language-bash">  mc alias/);
  assert.match(render(text), /\nmc ls local/);
});

test('JSON string deltas preserve whitespace and are not silently discarded', async () => {
  const deltas = ['##', ' ', '标题', '\n\n', '```bash', '\n', 'echo hi', '\n```'];
  assert.equal(await streamed(deltas.map(value => JSON.stringify(value)).join('\n') + '\n' + done), deltas.join(''));
});

test('plain SSE deltas retain separator whitespace, indentation and newline-only events', async () => {
  const wire = 'data: ##\n\ndata:  \n\ndata: 标题\n\ndata: \ndata: \ndata: \n\ndata: ```bash\n\ndata: \ndata:   echo hi\ndata: ```\n\ndata: [DONE]\n\n';
  assert.equal(await streamed(wire), '## 标题\n\n```bash\n  echo hi\n```');
});

test('structured SSE and child-agent deltas preserve original quoted content', async () => {
  const deltas = ['## 标题\n', '"quoted"', '\n', '"\\n"'];
  const wire = deltas.map(content => `data: ${JSON.stringify({ event: 'agent_text', agentCallId: 'child', content })}\n\n`).join('') + `data: ${done}\n\n`;
  assert.equal(await streamed(wire), deltas.join(''));
});

test('screenshot headings and compact shell fences render as separate headings and code blocks', () => {
  const input = '###4. 查看版本控制状态 ```bashmc version info myminio/test-bucket```\n\n##方式二：进入容器\n\n```bashdocker exec -it minio sh```';
  const html = render(input);
  assert.match(html, /<h3>4\. 查看版本控制状态<\/h3>/);
  assert.match(html, /<h2>方式二：进入容器<\/h2>/);
  assert.match(html, /<code class="language-bash">mc version info myminio\/test-bucket\n/);
  assert.match(html, /<code class="language-bash">docker exec -it minio sh\n/);
});

test('misplaced opening command no longer becomes hidden code-block metadata', () => {
  const input = '```bashmc alias set local http://127.0.0.1:9000 "$USER" "$PASSWORD"\nmc version enable local/bucket```\n\n这里不用手动写账号密码。';
  const html = render(input);
  assert.match(html, /<code class="language-bash">mc alias set local/);
  assert.match(html, /\nmc version enable local\/bucket\n<\/code><\/pre>/);
  assert.match(html, /<p>这里不用手动写账号密码。<\/p>/);
});

test('valid fences retain commands, quoted strings, Markdown samples and heredocs byte-for-byte', () => {
  const input = '## 正常标题\n\n````bash title="sample"\n  cat <<\'EOF\'\n##不能修改\n```bashmc example```\nEOF\nprintf "\\n"\ndocker run \\\n  --rm minio/mc\n````\n\n~~~text\n##保持原文\n~~~';
  assert.equal(prepareAssistantMarkdown(input), input);
});

test('tables, inline code, URLs, headings, raw HTML handling and unknown language info remain standard Markdown', () => {
  const input = '#tag\n#!/bin/sh\n`bashmc alias`\n\n## Title\n\n| Key | Value |\n| --- | --- |\n| x | `mc ls` |\n\n```bashful\ntext\n```\n\n<script>alert(1)</script>';
  assert.equal(prepareAssistantMarkdown(input), input);
  const html = render(input);
  assert.match(html, /<table>/);
  assert.match(html, /<code>mc ls<\/code>/);
  assert.doesNotMatch(html, /<script>/);
});

test('missing command separators are never guessed; source data remains available unchanged', () => {
  const input = '```bashmc alias set local URL USER PASSWORDmc version enable local/bucket```';
  const normalized = prepareAssistantMarkdown(input);
  assert.ok(normalized.includes('PASSWORDmc version'));
  assert.ok(!normalized.includes('PASSWORD\nmc'));
  assert.equal(prepareAssistantMarkdown(normalized), normalized);
});

test('incomplete streaming fences keep code visible and converge when the closing fence arrives', () => {
  const input = '```bashmc ls local';
  assert.match(render(input), /<code class="language-bash">mc ls local\n/);
  assert.match(render(input + '```\n\n完成'), /<\/pre>\n<p>完成<\/p>/);
});

test('plain SSE tokens that look like JSON primitives are still visible content', async () => {
  const tokens = ['9000', ' ', 'true', ' ', 'null', ' ', '[1,2]'];
  const wire = tokens.map(token => `data: ${token}\n\n`).join('') + 'data: [DONE]\n\n';
  assert.equal(await streamed(wire), tokens.join(''));
});

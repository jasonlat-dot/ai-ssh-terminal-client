import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { prepareAssistantMarkdown, renderableAssistantMarkdown } from '../src/state/assistantMarkdown.ts';
import { agentApi } from '../src/api/agent.ts';
import { adoptBundledBackendUrl, BUILTIN_ENDPOINT } from '../src/config/backend.ts';

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: prepareAssistantMarkdown(text) }));
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  adoptBundledBackendUrl(BUILTIN_ENDPOINT);
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
async function streamed(deltas: string[], child = false, encoded = false) {
  adoptBundledBackendUrl(BUILTIN_ENDPOINT);
  globalThis.fetch = async () => { throw new Error('native chat must not use HTTP'); };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    transformCallback: () => 1, unregisterCallback() {},
    invoke: async (command: string, args: any) => {
      if (command === 'builtin_agent_ack') return;
      assert.equal(command, 'builtin_agent_subscribe');
      let sequence = 0;
      for (const content of deltas) {
        const payload = child ? {event:'agent_text', agentCallId:'child', content} : {event:'text', content};
        await args.onEvent.onmessage({sequence:++sequence, requestId:args.request.requestId, payload:encoded?JSON.stringify(payload):payload});
      }
      await args.onEvent.onmessage({sequence:++sequence, requestId:args.request.requestId, payload:{event:'done',content:''}});
    },
  } } });
  let text = '';
  await agentApi.chatStream({ agentId:'a',userId:'u',sessionId:'s',terminalSessionId:'',message:'hello' }, event => {
    if (event.event === 'text' || event.event === 'agent_text') text += event.content;
  });
  return text;
}

test('native Channel deltas retain every newline, quote, escape and Unicode character', async () => {
  const deltas = ['##', ' ', '进入容器', '\n\n', '```', 'bash', '\n', '  mc alias set local ', '"http://127.0.0.1:9000"', ' ', '"\\n"', '\n', 'mc ls local', '\n', '```'];
  const text = await streamed(deltas);
  assert.equal(text, deltas.join(''));
  assert.match(render(text), /<h2>进入容器<\/h2>/);
  assert.match(render(text), /<pre><code class="language-bash">  mc alias/);
  assert.match(render(text), /\nmc ls local/);
});

test('serialized native payloads preserve whitespace without double decoding content', async () => {
  const deltas = ['##', ' ', '标题', '\n\n', '```bash', '\n', 'echo hi', '\n```'];
  assert.equal(await streamed(deltas, false, true), deltas.join(''));
});

test('native whitespace-only deltas preserve indentation and paragraph separators', async () => {
  const deltas = ['##', ' ', '标题', '\n\n', '```bash', '\n', '  echo hi', '\n```'];
  assert.equal(await streamed(deltas), '## 标题\n\n```bash\n  echo hi\n```');
});

test('native child-agent deltas preserve original quoted content', async () => {
  const deltas = ['## 标题\n', '"quoted"', '\n', '"\\n"'];
  assert.equal(await streamed(deltas, true), deltas.join(''));
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

test('native text that looks like JSON primitives remains visible literal content', async () => {
  const tokens = ['9000', ' ', 'true', ' ', 'null', ' ', '[1,2]'];
  assert.equal(await streamed(tokens), tokens.join(''));
});


test('glued numbered Chinese subheading becomes a separate heading without rewriting prose', () => {
  const source = '## 方法一：使用 `mc` 客户端开启###1. 配置 MinIO连接如果本机没有 `mc`，可以用 Docker 临时运行：';
  const html = render(source);
  assert.match(html, /<h2>方法一：使用 <code>mc<\/code> 客户端开启<\/h2>/);
  assert.match(html, /<h3>1\. 配置 MinIO连接如果本机没有/);
});

test('glued heading repair protects inline code, escaped hashes, links and fenced content', () => {
  for (const source of [
    '## 示例 `开启###1. 命令`',
    '## 示例 [开启###1. 链接](https://example.test)',
    '## 示例 开启\\###1. 保留',
    '```md\n## 开启###1. 字面值\n```',
  ]) assert.equal(prepareAssistantMarkdown(source), source);
});

test('compact plaintext fences keep original env names and output bytes', () => {
  assert.equal(prepareAssistantMarkdown('```textMINIO_ACCESS_KEYMINIO_SECRET_KEY```'), '```text\nMINIO_ACCESS_KEYMINIO_SECRET_KEY\n```');
  assert.equal(prepareAssistantMarkdown('```textmyminio/test-bucket versioning is enabled```'), '```text\nmyminio/test-bucket versioning is enabled\n```');
  assert.equal(prepareAssistantMarkdown('`textMINIO_ACCESS_KEY`'), '`textMINIO_ACCESS_KEY`');
});

test('Remend only completes formatting during streaming and never changes copied source', () => {
  const source = '正在 **分析';
  const streamed = renderableAssistantMarkdown(source, true);
  assert.match(render(streamed), /<strong>分析<\/strong>/);
  assert.equal(renderableAssistantMarkdown(source, false), source);
  const code = '```bash\nprintf "**hello"\n';
  assert.ok(renderableAssistantMarkdown(code, true).includes('printf "**hello"'));
});

test('highlighter preserves escapes and displays unknown languages as plain text', () => {
  const renderHighlighted = (source: string) => renderToStaticMarkup(createElement(ReactMarkdown, {
    rehypePlugins: [[rehypeHighlight, { detect: false, plainText: ['text', 'log'] }]], children: source,
  }));
  const html = renderHighlighted('```bash\necho "$HOME"\n```');
  assert.match(html, /hljs-built_in/);
  assert.match(html, /\$HOME/);
  assert.match(renderHighlighted('```unknown-custom\nkeep <tags> & "quotes"\n```'), /keep &lt;tags&gt; &amp; &quot;quotes&quot;/);
  assert.doesNotMatch(renderHighlighted('```text\necho hello\n```'), /hljs-built_in/);
});

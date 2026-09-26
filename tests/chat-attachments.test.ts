import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AttachmentPreviews, ChatAttachmentDraft, attachmentReferences, chatAttachmentPolicy, insertPastedText, pastedFiles, storedAttachments, validateChatAttachments, validateChatContent } from '../src/state/chatAttachments.ts';
import { agentApi } from '../src/api/agent.ts';
import { ChatRequestError, chatErrorGuidance } from '../src/api/chatErrors.ts';
import { ApiRequestError } from '../src/api/client.ts';
import { uploadFile } from '../src/api/files.ts';
import type { UploadedFile } from '../src/api/files.ts';

const originalFetch = globalThis.fetch;
const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
const file = (name = 'photo.png', size = 10) => new File([new Uint8Array(size)], name, { type: name.endsWith('.png') ? 'image/png' : 'text/plain', lastModified: 12 });
const result = (id: string): UploadedFile => ({ fileId: id, fileName: 'photo.png', contentType: 'image/png', size: 10, status: 'UPLOADED', downloadUrl: 'https://storage.test/photo?signature=abc%2Fdef', urlExpiresAt: '2000-01-01T00:00:00Z' });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clipboard(items: { kind: string; getAsFile: () => File | null }[], files: File[] = []) {
  return { items, files } as unknown as DataTransfer;
}
function backend() { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'https://api.example.test' } }); }

test('plain text, URLs, paths and base64-looking text never become files', () => {
  for (const text of ['hello', '/home/file.png', 'C:\\files\\photo.png', 'https://example.test/photo.png', 'data:image/png;base64,AAAA']) {
    const data = clipboard([{ kind: 'string', getAsFile: () => { throw new Error(text); } }]);
    assert.deepEqual(pastedFiles(data), []);
  }
});

test('screenshots prefer file items and never enumerate duplicate clipboard.files; fallback handles real files', () => {
  const screenshot = file();
  const data = clipboard([{ kind: 'file', getAsFile: () => screenshot }]);
  Object.defineProperty(data, 'files', { get: () => { throw new Error('must not traverse twice'); } });
  assert.deepEqual(pastedFiles(data), [screenshot]);
  assert.deepEqual(pastedFiles(clipboard([], [screenshot])), [screenshot]);
  assert.deepEqual(pastedFiles(clipboard([{ kind: 'file', getAsFile: () => null }], [screenshot])), [screenshot]);
  const unnamed = new File(['bytes'], '', { type: 'image/png' });
  const normalized = pastedFiles(clipboard([], [unnamed]))[0];
  assert.equal(normalized.name, 'clipboard-1.png');
  assert.equal(normalized.size, unnamed.size);
});

test('mixed paste inserts text at caret or selection without replacing the draft', () => {
  assert.deepEqual(insertPastedText('before after', 'hello', 7, 7), { text: 'before helloafter', cursor: 12 });
  assert.deepEqual(insertPastedText('before OLD after', 'new', 7, 10), { text: 'before new after', cursor: 10 });
});

test('chat validates count, original aggregate size, empty files and narrower formats', () => {
  assert.match(validateChatAttachments(Array.from({ length: 5 }, () => ({ name: 'x.png', size: 1 })))!, /4/);
  assert.equal(validateChatAttachments([{ name: 'x.txt', size: chatAttachmentPolicy.maxBytes }]), null);
  assert.match(validateChatAttachments([{ name: 'x.txt', size: chatAttachmentPolicy.maxBytes + 1 }])!, /20 MB/);
  for (const name of ['a.docx', 'a.xlsx', 'a.gif', 'a.exe', 'png']) assert.match(validateChatAttachments([{ name, size: 1 }])!, /暂不支持/);
  assert.match(validateChatAttachments([{ name: 'a.txt', size: 0 }])!, /空文件/);
  assert.equal(validateChatAttachments([{ name: 'PHOTO.PNG', size: 1 }]), null);
});

test('batch limit includes existing attachments and rejects the whole batch before upload', () => {
  const previews = new AttachmentPreviews();
  let calls = 0;
  const draft = new ChatAttachmentDraft(previews, async () => { calls++; return result('new'); });
  draft.attach([result('old')]);
  assert.throws(() => draft.add([file('a.png'), file('b.png'), file('c.png'), file('d.png')]), /4/);
  assert.equal(calls, 0);
  assert.equal(draft.getSnapshot().length, 1);
  assert.throws(() => draft.add([file('good.txt'), file('bad.docx')]), /暂不支持/);
  assert.equal(calls, 0);
  assert.throws(() => draft.attach([result('old')]), /重复附加/);
  draft.clear(); previews.dispose();
});

test('two concurrent uploads, failed retry keeps File, and pending/error states block the entire send', async () => {
  const pending: ReturnType<typeof deferred<UploadedFile>>[] = [];
  const previews = new AttachmentPreviews();
  const draft = new ChatAttachmentDraft(previews, () => { const p = deferred<UploadedFile>(); pending.push(p); return p.promise; });
  const original = file('a.png');
  draft.add([original, file('b.png'), file('c.png')]);
  assert.equal(pending.length, 2);
  assert.throws(() => draft.ready(), /等待上传/);
  pending[0].reject(new ApiRequestError('上传繁忙', 'http', 'FILE_UPLOAD_BUSY', 429));
  await flush();
  assert.equal(pending.length, 3);
  assert.equal(draft.getSnapshot()[0].file, original);
  assert.throws(() => draft.ready(), /重试或移除/);
  draft.retry(draft.getSnapshot()[0].id);
  draft.retry(draft.getSnapshot()[0].id);
  assert.equal(pending.length, 3);
  pending[1].resolve(result('b')); await flush();
  assert.equal(pending.length, 4);
  pending[2].resolve(result('c')); pending[3].resolve(result('a')); await flush();
  assert.equal(draft.ready().length, 3);
  draft.clear(); previews.dispose();
});

test('remove queued/uploading files cancels only that request and ignores late results; clear never starts waiting files', async () => {
  const pending: { signal: AbortSignal; request: ReturnType<typeof deferred<UploadedFile>> }[] = [];
  const previews = new AttachmentPreviews();
  const draft = new ChatAttachmentDraft(previews, (_file, signal) => { const request = deferred<UploadedFile>(); pending.push({ signal, request }); return request.promise; });
  draft.add([file('a.png'), file('b.png'), file('c.png')]);
  draft.remove(draft.getSnapshot()[2].id);
  assert.equal(pending.length, 2);
  draft.remove(draft.getSnapshot()[0].id);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[0].request.resolve(result('removed')); await flush();
  assert.equal(draft.getSnapshot().length, 1);
  draft.clear();
  draft.add([file('x.png'), file('y.png'), file('z.png')]);
  const count = pending.length;
  draft.clear();
  assert.equal(pending.length, count);
  pending[1].request.resolve(result('old-scope')); await flush();
  assert.equal(draft.getSnapshot().length, 0);
  previews.dispose();
});

test('attachment-only send uses only file IDs; expired links can be reattached without upload', () => {
  const previews = new AttachmentPreviews();
  const draft = new ChatAttachmentDraft(previews, async () => { throw new Error('must reuse ID'); });
  draft.attach([result('reuse')]);
  const snapshot = draft.ready();
  assert.equal(validateChatContent('', snapshot), null);
  assert.match(validateChatContent('', [])!, /文字或添加附件/);
  assert.deepEqual(attachmentReferences(snapshot), [{ fileId: 'reuse' }]);
  draft.clear();
  assert.equal(snapshot[0].fileId, 'reuse');
  draft.attach(snapshot);
  assert.equal(draft.ready()[0].fileId, 'reuse');
  assert.match(validateChatContent('hi', [snapshot[0], snapshot[0]])!, /重复/);
  draft.clear(); previews.dispose();
});

test('preview remains live while a message references it; history strips blob URLs', () => {
  const pool = new AttachmentPreviews();
  const realRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.revokeObjectURL = url => { revoked.push(url); realRevoke(url); };
  try {
    const url = pool.create(file())!;
    pool.reconcile([url]);
    pool.reconcile([url]); // draft removed, message still retains the same URL
    assert.deepEqual(revoked, []);
    const metadata = storedAttachments([{ ...result('saved'), previewUrl: url, file: file() }]);
    assert.ok(!('previewUrl' in metadata[0]));
    assert.ok(!('file' in metadata[0]));
    assert.equal(metadata[0].fileId, 'saved');
    pool.reconcile([]);
    assert.deepEqual(revoked, [url]);
  } finally { URL.revokeObjectURL = realRevoke; pool.dispose(); }
});

test('upload accepts required attachment response fields without optional SHA/status', async () => {
  backend();
  const { status: _status, ...data } = result('uploaded');
  globalThis.fetch = async () => Response.json({ code: 'SUCCESS_0000', data });
  assert.equal((await uploadFile(file())).fileId, 'uploaded');
});

const requestBody = { agentId: 'agent', userId: 'user', sessionId: 'session', terminalSessionId: '', message: '', attachments: [{ fileId: 'ref' }] };
for (const code of ['CHAT_CONTENT_REQUIRED', 'CHAT_ATTACHMENT_INVALID', 'CHAT_ATTACHMENT_FORBIDDEN', 'CHAT_ATTACHMENT_LIMIT', 'CHAT_ATTACHMENT_UNSUPPORTED', 'CHAT_ATTACHMENT_CONTENT_INVALID', 'CHAT_MODEL_MEDIA_UNSUPPORTED', 'CHAT_ATTACHMENT_BUSY', 'FILE_READ_FAILED', 'FILE_STORAGE_UNAVAILABLE']) {
  test(`HTTP 200 streaming ${code} rejects immediately, preserves content/code, cancels reader and never retries`, async () => {
    backend(); let calls = 0; let cancelled = false;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.deepEqual(JSON.parse(String(options?.body)), requestBody);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ event: 'error', content: '附件处理错误', code }) + '\n'));
      }, cancel() { cancelled = true; } }));
    };
    const events: string[] = [];
    await assert.rejects(agentApi.chatStream(requestBody, event => events.push(event.event)), error => error instanceof ChatRequestError && error.code === code && error.message === '附件处理错误');
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.ok(!events.includes('done'));
    assert.ok(chatErrorGuidance(code));
  });
}

test('JSON Lines still handles UTF-8 split across chunks and explicit done; EOF alone is not success', async () => {
  backend();
  const raw = new TextEncoder().encode('{"event":"text","content":"图片分析"}\n{"event":"done","content":"完成"}\n');
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < raw.length; offset += 2) controller.enqueue(raw.slice(offset, offset + 2));
    controller.close();
  } }));
  const events: string[] = [];
  await agentApi.chatStream({ ...requestBody, attachments: undefined, message: 'plain' }, event => events.push(event.event));
  assert.deepEqual(events, ['text', 'done']);
  globalThis.fetch = async () => new Response('{"event":"text","content":"partial"}\n');
  await assert.rejects(agentApi.chatStream(requestBody, () => {}), error => error instanceof ChatRequestError && error.code === 'CHAT_STREAM_INTERRUPTED');
});

test('stream error after partial text prevents a later done; HTTP errors use backend info', async () => {
  backend();
  globalThis.fetch = async () => new Response('{"event":"text","content":"partial"}\n{"event":"error","content":"文本太长","code":"CHAT_ATTACHMENT_LIMIT"}\n{"event":"done","content":"false success"}\n');
  const events: string[] = [];
  await assert.rejects(agentApi.chatStream(requestBody, event => events.push(event.event)), /文本太长/);
  assert.deepEqual(events, ['text']);
  globalThis.fetch = async () => Response.json({ code: 'CHAT_ATTACHMENT_FORBIDDEN', info: '没有附件权限' }, { status: 403 });
  await assert.rejects(agentApi.chatStream(requestBody, () => {}), error => error instanceof ChatRequestError && error.code === 'CHAT_ATTACHMENT_FORBIDDEN' && error.message === '没有附件权限');
});

test('legacy SSE data events remain supported', async () => {
  backend();
  globalThis.fetch = async () => new Response('data: {"event":"text","content":"hello"}\n\ndata: {"event":"done","content":"ok"}\n\n');
  const events: string[] = [];
  await agentApi.chatStream(requestBody, event => events.push(event.event));
  assert.deepEqual(events, ['text', 'done']);
});

test('HTTP 200 business error envelope is not treated as text/success', async () => {
  backend();
  globalThis.fetch = async () => Response.json({ code: 'CHAT_ATTACHMENT_LIMIT', info: '文本正文总长度超限', data: null });
  await assert.rejects(agentApi.chatStream(requestBody, () => {}), error => error instanceof ChatRequestError && error.code === 'CHAT_ATTACHMENT_LIMIT' && error.message === '文本正文总长度超限');
});

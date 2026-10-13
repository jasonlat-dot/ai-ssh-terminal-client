import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AttachmentPreviews, ChatAttachmentDraft, attachmentReferences, chatAttachmentPolicy, createChatTextAttachment, isLongChatText, textCharacters, insertPastedText, pastedFiles, storedAttachments, validateChatAttachments, validateChatContent } from '../src/state/chatAttachments.ts';
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

test('99 characters stay inline, 100 become cards; Unicode characters rather than bytes or UTF-16 units', () => {
  assert.equal(isLongChatText('x'.repeat(99)), false);
  assert.equal(isLongChatText('x'.repeat(100)), true);
  assert.equal(isLongChatText('😀'.repeat(99)), false);
  assert.equal(isLongChatText('中'.repeat(100)), true);
  assert.equal(textCharacters('中文😀\r\n'), 5);
});

test('text card preserves complete UTF-8 text, line breaks and leading/trailing spaces; preview bounded and escaped by React', async () => {
  const text = '  C:\\Users\\Admin\r\n' + '<script>你好😀</script>\n'.repeat(30) + '  ';
  const prepared = createChatTextAttachment(text, 'terminal');
  assert.equal(await prepared.file.text(), text);
  assert.equal(prepared.file.type, 'text/plain'); assert.match(prepared.file.name, /终端选中文本.*\.txt$/);
  assert.equal(prepared.excerpt.characters, textCharacters(text));
  assert.ok(textCharacters(prepared.excerpt.preview) <= 120);
  assert.equal(prepared.excerpt.source, 'terminal');
});

test('short text never uploads; long text uses existing queue, metadata survives upload/history/reattach, wire sends only ID', async () => {
  const previews = new AttachmentPreviews(), captured: File[] = [];
  const draft = new ChatAttachmentDraft(previews, async file => {
    captured.push(file); return { ...result('text-ref'), fileName: file.name, size: file.size, contentType: file.type };
  });
  assert.equal(draft.addText('short', 'paste'), 'short'); assert.equal(captured.length, 0);
  const text = '日志行😀\n'.repeat(40);
  assert.equal(draft.addText(text, 'paste'), ''); assert.equal(captured.length, 1);
  assert.throws(() => draft.ready(), /等待上传/);
  await flush();
  assert.equal(await captured[0].text(), text);
  assert.equal(draft.getSnapshot()[0].file, undefined);
  const files = draft.ready(); assert.equal(files[0].textExcerpt?.source, 'paste');
  assert.equal(validateChatContent('', files), null);
  assert.deepEqual(attachmentReferences(files), [{ fileId: 'text-ref' }]);
  const stored = storedAttachments(files); assert.deepEqual(stored[0].textExcerpt, files[0].textExcerpt);
  draft.clear(); draft.attach(stored); assert.equal(captured.length, 1);
  assert.deepEqual(draft.getSnapshot()[0].textExcerpt, files[0].textExcerpt);
  draft.clear(); previews.dispose();
});

test('text cards share attachment count/byte limits; mixed paste rejects atomically, and failed upload retains text for retry', async () => {
  const previews = new AttachmentPreviews(); let calls = 0;
  const draft = new ChatAttachmentDraft(previews, async file => {
    if (++calls === 1) throw new Error('offline');
    return { ...result('retry'), fileName: file.name, size: file.size, contentType: file.type };
  });
  assert.throws(() => draft.addText('x'.repeat(100), 'paste', Array.from({ length: 4 }, (_, i) => file(`a${i}.txt`))), /4/);
  assert.equal(calls, 0); assert.equal(draft.getSnapshot().length, 0);
  assert.throws(() => draft.addText('x'.repeat(100), 'paste', [file('huge.txt', chatAttachmentPolicy.maxBytes)]), /20 MB/);
  assert.equal(calls, 0);
  const text = 'original logs\n'.repeat(20); draft.addText(text, 'terminal'); await flush();
  assert.equal(draft.getSnapshot()[0].status, 'error'); assert.equal(await draft.getSnapshot()[0].file!.text(), text);
  assert.throws(() => draft.ready(), /重试或移除/);
  draft.retry(draft.getSnapshot()[0].id); await flush(); assert.equal(draft.ready()[0].textExcerpt?.source, 'terminal');
  draft.remove(draft.getSnapshot()[0].id); assert.equal(draft.getSnapshot().length, 0); previews.dispose();
});

test('malformed text-card history metadata cannot masquerade as a legitimate source', () => {
  for (const textExcerpt of [{ source: 'other', characters: 100, preview: 'x' }, { source: 'terminal', characters: -1, preview: 'x' }, { source: 'paste', characters: 100, preview: {} }]) {
    assert.equal(storedAttachments([{ ...result('saved'), textExcerpt }])[0].textExcerpt, undefined);
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

test('WebView file uploads cannot fall back to a remote attachment server', async () => {
  await assert.rejects(uploadFile(file()),error=>error instanceof ApiRequestError&&error.code==='FILE_NATIVE_PICKER_REQUIRED');
});
test('Rust Agent is not enabled by a legacy server address',async()=>{
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=> 'https://retired.example.test'}});
  globalThis.fetch=async()=>{throw new Error('Agent must not call a legacy HTTP backend');};
  await assert.rejects(agentApi.chatStream({agentId:'agent',userId:'default',sessionId:'chat',terminalSessionId:'terminal',message:'hello'},()=>{}),
    error=>error instanceof ChatRequestError&&error.code==='FEATURE_NOT_MIGRATED');
});

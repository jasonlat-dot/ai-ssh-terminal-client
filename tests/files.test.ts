import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { apiRequest, apiUrl, ApiRequestError } from '../src/api/client.ts';
import { downloadExpiresAt, downloadUnavailable, uploadFile } from '../src/api/files.ts';
import type { UploadedFile } from '../src/api/files.ts';
import { fileUploadPolicy, validateUploadFile } from '../src/config/fileUpload.ts';
import { FileUploadQueue } from '../src/state/fileUploads.ts';

const realFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const realTimeout = fileUploadPolicy.timeoutMs;
afterEach(() => {
  globalThis.fetch = realFetch;
  fileUploadPolicy.timeoutMs = realTimeout;
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
function configureBackend(url = 'https://api.example.test/proxy/api/v1') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => url } });
}
const result: UploadedFile = {
  fileId: 'file-1', fileName: 'report.txt', contentType: 'text/plain', size: 5,
  sha256: 'abc123', status: 'UPLOADED',
  downloadUrl: 'https://storage.example.test/bucket/report.txt?X-Amz-Signature=a%2Fb%2Bz&filename=a+b',
  urlExpiresAt: '2035-01-01T00:15:00Z',
};
const success = () => Response.json({ code: 'SUCCESS_0000', info: 'ok', data: result });
const file = (name = 'report.txt') => new File(['hello'], name, { type: 'text/plain', lastModified: 123 });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('normal upload: shared base URL, one multipart file, no Content-Type/userId, preserves all response fields', async () => {
  configureBackend();
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://api.example.test/proxy/api/v1/files');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.headers, undefined);
    assert.ok(options?.body instanceof FormData);
    assert.deepEqual(Array.from(options.body.keys()), ['file']);
    assert.equal((options.body.get('file') as File).name, 'report.txt');
    return success();
  };
  assert.deepEqual(await uploadFile(file()), result);
  assert.equal(requests, 1);
  for (const base of ['https://a.test', 'https://a.test/', 'https://a.test/api/v1', 'https://a.test/api/v1/']) {
    assert.equal(apiUrl(base, 'files'), 'https://a.test/api/v1/files');
  }
});

test('empty, too large and unsupported files never issue requests; extension is case insensitive', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return success(); };
  await assert.rejects(uploadFile(new File([], 'empty.txt')), /空文件/);
  await assert.rejects(uploadFile(new File([new Uint8Array(fileUploadPolicy.maxBytes + 1)], 'large.pdf')), /上限/);
  await assert.rejects(uploadFile(file('script.exe')), /扩展名/);
  assert.equal(requests, 0);
  assert.equal(validateUploadFile({ name: 'IMAGE.PNG', size: 1 }), null);
  assert.equal(validateUploadFile({ name: 'report.pdf', size: fileUploadPolicy.maxBytes }), null);
  assert.match(validateUploadFile({ name: 'noextension', size: 1 })!, /扩展名/);
});

for (const [status, code, info] of [
  [503, 'FILE_STORAGE_NOT_CONFIGURED', '文件存储未配置'],
  [503, 'FILE_STORAGE_CONFIG_INVALID', '文件存储配置不完整'],
  [503, 'FILE_STORAGE_UNAVAILABLE', '文件存储服务不可用'],
  [400, 'FILE_INVALID', '文件内容无效'],
  [400, 'FILE_TYPE_NOT_ALLOWED', '文件类型不允许'],
  [413, 'FILE_TOO_LARGE', '文件超过后端上限'],
  [429, 'FILE_UPLOAD_BUSY', '上传任务繁忙，请稍后重试'],
  [500, 'FILE_UPLOAD_FAILED', '文件上传失败'],
] as const) {
  test(`${code}: preserve backend info, code and HTTP status`, async () => {
    configureBackend();
    globalThis.fetch = async () => Response.json({ code, info, data: null }, { status });
    await assert.rejects(uploadFile(file()), error => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.message, info);
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
      return true;
    });
  });
}

test('HTTP 200 alone is not success; malformed/non-JSON responses use general messages', async () => {
  configureBackend();
  globalThis.fetch = async () => Response.json({ code: 'FILE_UPLOAD_FAILED', info: '未完成保存' });
  await assert.rejects(uploadFile(file()), /未完成保存/);
  globalThis.fetch = async () => new Response('<html>unavailable</html>', { status: 503 });
  await assert.rejects(uploadFile(file()), /HTTP 503/);
  globalThis.fetch = async () => Response.json(null, { status: 500 });
  await assert.rejects(uploadFile(file()), /HTTP 500/);
  globalThis.fetch = async () => Response.json({ code: 'SUCCESS_0000', data: null });
  await assert.rejects(uploadFile(file()), /上传响应不完整/);
  globalThis.fetch = async () => Response.json({ code: 'SUCCESS_0000', data: { ...result, status: 'PROCESSING' } });
  await assert.rejects(uploadFile(file()), /文件状态异常/);
});

test('shared client preserves JSON SSH requests while accepting FormData', async () => {
  configureBackend('https://api.example.test');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.example.test/api/v1/ssh/terminal/write?sessionId=tab-1');
    assert.deepEqual(options?.headers, { 'Content-Type': 'application/json' });
    assert.equal(options?.body, '{"input":"ls"}');
    return Response.json({ code: 'SUCCESS_0000', data: null });
  };
  await apiRequest('ssh/terminal/write', { method: 'POST', body: { input: 'ls' }, params: { sessionId: 'tab-1' } });
});

test('network failure and timeout are classified; failed files are retained and never automatically retried', async () => {
  configureBackend();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('offline'); };
  const queue = new FileUploadQueue();
  const original = file();
  queue.add([original]);
  await flush();
  const item = queue.getSnapshot()[0];
  assert.equal(item.status, 'error');
  assert.equal(item.file, original);
  assert.equal(item.uncertain, true);
  await flush();
  assert.equal(calls, 1);
  fileUploadPolicy.timeoutMs = 5;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
  });
  await assert.rejects(uploadFile(file()), error => error instanceof ApiRequestError && error.kind === 'timeout');
  queue.deactivate();
});

test('a network failure while reading the response body remains an uncertain upload outcome', async () => {
  configureBackend();
  globalThis.fetch = async () => Object.assign(success(), {
    json: async () => { throw new TypeError('response stream interrupted'); },
  });
  const queue = new FileUploadQueue();
  queue.add([file()]);
  await flush();
  assert.equal(queue.getSnapshot()[0].status, 'error');
  assert.equal(queue.getSnapshot()[0].uncertain, true);
  assert.match(queue.getSnapshot()[0].error!, /网络连接/);
  queue.deactivate();
});

test('at most two uploads, duplicate submissions blocked, success waits for backend, manual retry runs once', async () => {
  const pending: ReturnType<typeof deferred<UploadedFile>>[] = [];
  const queue = new FileUploadQueue(() => {
    const request = deferred<UploadedFile>();
    pending.push(request);
    return request.promise;
  });
  const first = file('first.txt');
  queue.add([first, file('second.txt'), file('third.txt')]);
  assert.equal(pending.length, 2);
  assert.deepEqual(queue.getSnapshot().map(item => item.status), ['uploading', 'uploading', 'queued']);
  assert.equal(queue.add([first]), 1);
  assert.equal(pending.length, 2);
  const firstId = queue.getSnapshot()[0].id;
  queue.remove(firstId);
  assert.equal(queue.getSnapshot().length, 3);
  pending[0].resolve(result);
  await flush();
  assert.equal(pending.length, 3);
  assert.equal(queue.getSnapshot()[0].status, 'success');
  assert.deepEqual(queue.getSnapshot()[0].result, result);
  pending[1].reject(new ApiRequestError('存储未配置', 'http', 'FILE_STORAGE_NOT_CONFIGURED', 503));
  await flush();
  const secondId = queue.getSnapshot()[1].id;
  assert.equal(queue.getSnapshot()[1].error, '存储未配置');
  assert.equal(pending.length, 3);
  queue.retry(secondId);
  queue.retry(secondId);
  assert.equal(pending.length, 4);
  queue.remove(firstId);
  assert.equal(queue.getSnapshot().length, 2);
  pending[2].resolve(result);
  pending[3].resolve(result);
  await flush();
  queue.deactivate();
});

test('invalid queue items can be removed locally; stale responses cannot overwrite a retry', async () => {
  const pending: ReturnType<typeof deferred<UploadedFile>>[] = [];
  const queue = new FileUploadQueue(() => {
    const request = deferred<UploadedFile>(); pending.push(request); return request.promise;
  });
  queue.add([new File([], 'empty.txt'), file()]);
  assert.equal(queue.getSnapshot()[0].retryable, false);
  queue.retry(queue.getSnapshot()[0].id);
  assert.equal(pending.length, 1);
  queue.remove(queue.getSnapshot()[0].id);
  const id = queue.getSnapshot()[0].id;
  queue.deactivate();
  queue.activate();
  queue.retry(id);
  pending[0].resolve({ ...result, fileId: 'stale-file' });
  await flush();
  assert.equal(queue.getSnapshot()[0].status, 'uploading');
  pending[1].resolve(result);
  await flush();
  assert.equal(queue.getSnapshot()[0].result?.fileId, 'file-1');
  queue.deactivate();
});

test('signed URL expiration: exact boundary, timestamps, malformed time, unsafe URL', () => {
  const expiry = Date.parse(String(result.urlExpiresAt));
  assert.equal(downloadUnavailable(result, expiry - 1), null);
  assert.equal(downloadUnavailable(result, expiry), '下载链接已过期');
  assert.equal(downloadUnavailable(result, expiry + 1), '下载链接已过期');
  assert.equal(downloadExpiresAt(expiry), expiry);
  assert.equal(downloadExpiresAt(expiry / 1000), expiry);
  assert.equal(downloadUnavailable({ ...result, urlExpiresAt: 'invalid' }), '无法确认下载链接有效期');
  assert.equal(downloadUnavailable({ ...result, downloadUrl: 'javascript:alert(1)' }, expiry - 1), '下载链接不可用');
  assert.equal(result.downloadUrl, 'https://storage.example.test/bucket/report.txt?X-Amz-Signature=a%2Fb%2Bz&filename=a+b');
});

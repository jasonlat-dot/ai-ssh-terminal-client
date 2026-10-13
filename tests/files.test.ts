import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { apiRequest, ApiRequestError } from '../src/api/client.ts';
import { downloadUnavailable, uploadFile, readUploadedFile, listUploadedFiles, readFileStorageStats, deleteUploadedFile } from '../src/api/files.ts';
import type { UploadedFile } from '../src/api/files.ts';
import { fileUploadPolicy, validateUploadFile } from '../src/config/fileUpload.ts';
import { FileUploadQueue } from '../src/state/fileUploads.ts';
import { adoptBundledBackendUrl, BUILTIN_ENDPOINT } from '../src/config/backend.ts';
const realFetch=globalThis.fetch;
const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
afterEach(()=>{
  globalThis.fetch=realFetch; adoptBundledBackendUrl(BUILTIN_ENDPOINT);
  if(originalWindow) Object.defineProperty(globalThis,'window',originalWindow); else Reflect.deleteProperty(globalThis,'window');
});
const endpoint='ipc://builtin/00000000-0000-4000-8000-000000000001';
const result: UploadedFile={fileId:'file-1',fileName:'report.txt',contentType:'text/plain',size:5,
  sha256:'abc123',status:'UPLOADED',downloadUrl:`${endpoint}/files/00000000-0000-4000-8000-000000000003`,urlExpiresAt:'2000-01-01T00:00:00Z'};
const file=(name='report.txt')=>new File(['hello'],name,{type:'text/plain',lastModified:123});
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(handler:(args:Record<string,any>)=>unknown) {
  adoptBundledBackendUrl(endpoint);
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__TAURI_INTERNALS__:{
    invoke:(command:string,args:any)=>{assert.equal(command,'builtin_request');return handler(args.request);}
  }}});
  globalThis.fetch=async()=>{throw new Error('File operations must never call HTTP');};
}

test('attachments reject WebView byte uploads and keep native file validation rules',async()=>{
  await assert.rejects(uploadFile(file()),error=>error instanceof ApiRequestError&&error.code==='FILE_NATIVE_PICKER_REQUIRED');
  assert.ok(validateUploadFile(new File([],'empty.txt')));
  assert.ok(validateUploadFile(file('bad.exe')));
  assert.equal(validateUploadFile(file('REPORT.TXT')),null);
  assert.ok(fileUploadPolicy.maxBytes>0);
});
test('native references are usable without signed-link expiry, HTTP links are not',()=>{
  harness(()=>Promise.resolve());
  assert.equal(downloadUnavailable(result),null);
  assert.ok(downloadUnavailable({...result,downloadUrl:'https://retired.example.test/file'}));
  assert.ok(downloadUnavailable({...result,downloadUrl:'javascript:alert(1)'}));
});
test('metadata, history and deletion use IPC and retain the same workspace identity',async()=>{
  const calls:Record<string,any>[]=[];
  harness(args=>{calls.push(args);assert.equal(args.backendUrl,endpoint);
    if(args.endpoint==='files')return Promise.resolve({items:[result],offset:20,hasMore:false});
    return Promise.resolve(args.method==='DELETE'?null:result);});
  assert.deepEqual(await readUploadedFile(result.fileId),result);
  assert.equal((await listUploadedFiles(20)).items[0].downloadUrl,result.downloadUrl);
  await deleteUploadedFile(result.fileId);
  assert.deepEqual(calls.map(args=>[args.endpoint,args.method]),[['files/file-1','GET'],['files','GET'],['files/file-1','DELETE']]);
});
test('native storage errors remain business errors; malformed metadata is rejected',async()=>{
  harness(()=>Promise.reject({message:'附件已清理',code:'FILE_DOWNLOAD_NOT_FOUND',status:404}));
  await assert.rejects(readUploadedFile('missing'),error=>error instanceof ApiRequestError&&error.code==='FILE_DOWNLOAD_NOT_FOUND');
  harness(()=>Promise.resolve({...result,fileId:'wrong'}));
  await assert.rejects(readUploadedFile(result.fileId),error=>error instanceof ApiRequestError&&error.code==='FILE_RESPONSE_INVALID');
  await assert.rejects(apiRequest('files',{baseUrl:'https://retired.example.test'}));
});
test('capacity requires nonnegative safe integers and malformed history is rejected',async()=>{
  const stats={enabled:true,usedBytes:5,reservedBytes:0,maxStorageBytes:1024,fileCount:1,maxFiles:10000,maxFileBytes:20,retentionDays:0,downloadLinkSeconds:900};
  harness(()=>Promise.resolve(stats));assert.equal((await readFileStorageStats()).fileCount,1);
  harness(()=>Promise.resolve({...stats,usedBytes:-1}));await assert.rejects(readFileStorageStats());
  harness(()=>Promise.resolve({items:[{...result,size:0}],offset:0,hasMore:false}));await assert.rejects(listUploadedFiles());
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


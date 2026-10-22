import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalUpload, createSidebarTransfer, terminalUploadMatches, runTerminalUpload, runTerminalTransfer } from '../src/state/terminalUpload';
import { handleTerminalFileDrop } from '../src/state/terminalFileDrop';
import type { TerminalRuntime } from '../src/state/terminalRuntime';
import type { DragDropEvent } from '@tauri-apps/api/webview';

function fixture() {
  const directory = { path: '/root/project', accessKey: 'root-one', access: 'root', running: false };
  const runtime = { sessionId: 'ssh-one', connectionId: 'wsl', closed: false, disconnected: false, manuallyClosed: false,
    directorySnapshot: () => directory } as unknown as TerminalRuntime;
  return { directory, runtime, request: () => createTerminalUpload(runtime, 'tab-one', 'WSL', ['C:\\test\\a.txt', 'C:\\test\\a.txt', 'D:\\folder']) };
}

test('drop captures immutable destination and deduplicates absolute local file paths', () => {
  const f = fixture(), request = f.request();
  assert.deepEqual(request.paths, ['C:\\test\\a.txt', 'D:\\folder']);
  assert.equal(request.target.path, '/root/project');
  f.directory.path = '/root/other';
  assert.equal(request.target.path, '/root/project');
  assert.equal(terminalUploadMatches(f.runtime, request, true), false, 'changing cwd requires confirmation again');
  assert.equal(terminalUploadMatches(f.runtime, request), true, 'after confirmation upload uses the explicitly approved path');
  assert.throws(() => createTerminalUpload(f.runtime, 'tab', 'WSL', ['relative.txt', 'C:\\bad\nname']), /没有可上传/);
});

test('unknown cwd, busy prompt, unavailable identity and disconnected runtime cannot initiate upload', () => {
  for (const state of [{ path: '' }, { running: true }, { access: 'unavailable' }]) {
    const f = fixture(); Object.assign(f.directory, state); assert.throws(f.request);
  }
  for (const state of [{ closed: true }, { disconnected: true }, { manuallyClosed: true }, { transportAvailable: false }]) {
    const f = fixture(); Object.assign(f.runtime, state); assert.throws(f.request);
  }
});

test('confirmation cannot be redirected by reconnect, identity change or another terminal', () => {
  const f = fixture(), request = f.request();
  assert.equal(terminalUploadMatches(f.runtime, request, true), true);
  assert.equal(terminalUploadMatches({ ...f.runtime, sessionId: 'another' } as TerminalRuntime, request), false);
  f.directory.accessKey = 'login'; assert.equal(terminalUploadMatches(f.runtime, request), false);
  assert.equal(terminalUploadMatches(undefined, request), false);
});

test('confirmed upload connects once and submits each file to exactly the approved directory', async () => {
  const f = fixture(), request = f.request(), submitted: string[][] = [];
  let connections = 0;
  const result = await runTerminalUpload(request, { valid: () => terminalUploadMatches(f.runtime, request),
    connect: async () => { connections++; return true; },
    upload: async (path, destination) => { submitted.push([path, destination]); f.directory.path = '/root/changed-after-confirmation'; return true; } });
  assert.equal(connections, 1); assert.deepEqual(result, { submitted: 2, total: 2 });
  assert.deepEqual(submitted, request.paths.map(path => [path, '/root/project']));
});

test('identity revocation while connecting or uploading stops unsubmitted files', async () => {
  const f = fixture(), request = f.request(); let uploaded = 0;
  const result = await runTerminalUpload(request, { valid: () => terminalUploadMatches(f.runtime, request),
    connect: async () => true, upload: async () => { uploaded++; f.directory.accessKey = 'login'; return true; } });
  assert.equal(uploaded, 1); assert.equal(result.submitted, 1);
  const next = fixture(), nextRequest = next.request();
  await runTerminalUpload(nextRequest, { valid: () => terminalUploadMatches(next.runtime, nextRequest),
    connect: async () => { next.runtime.closed = true; return true; }, upload: async () => { assert.fail('revoked session cannot upload'); } });
  await runTerminalUpload(request, { valid: () => true, connect: async () => false, upload: async () => { assert.fail('failed connection cannot upload'); } });
});

test('physical DPI positions route a drop to its actual pane and ignore modal overlays', () => {
  const node = {} as Element, overlay = {} as Element;
  const surface = { contains: (target: Element) => target === node } as HTMLElement;
  const drops: string[][] = [], hover: boolean[] = [], positions: number[][] = [];
  let hit: Element = node;
  const options = { scale: 1.5, hit: (x: number, y: number) => { positions.push([x, y]); return hit; },
    hover: (value: boolean) => hover.push(value), drop: (paths: string[]) => drops.push(paths) };
  const event = { type: 'drop', position: { x: 300, y: 150 }, paths: ['C:\\a.txt'] } as DragDropEvent;
  handleTerminalFileDrop({ ...event, type: 'enter' } as DragDropEvent, surface, options);
  handleTerminalFileDrop(event, surface, options);
  assert.deepEqual(positions[0], [200, 100]); assert.deepEqual(drops, [['C:\\a.txt']]); assert.deepEqual(hover, [true, false]);
  hit = overlay; handleTerminalFileDrop(event, surface, options);
  assert.equal(drops.length, 1, 'another pane or overlay cannot receive this drop');
  handleTerminalFileDrop({ type: 'leave' }, surface, options); assert.equal(hover.at(-1), false);
});


test('sidebar transfers pin the browsed directory and download source independently of Shell cwd', async () => {
  const f = fixture();
  const request = createSidebarTransfer(f.runtime, 'tab-one', 'WSL', '/srv/files', ['D:\\downloads'], '中文.txt');
  assert.equal(request.target.path, '/srv/files'); assert.equal(request.direction, 'DOWNLOAD');
  assert.equal(terminalUploadMatches(f.runtime, request), true);
  const submitted: unknown[][] = [];
  const result = await runTerminalTransfer(request, {valid: () => terminalUploadMatches(f.runtime, request),
    connect: async () => true, transfer: async (...args) => { submitted.push(args); return true; }});
  assert.deepEqual(result, {submitted:1,total:1});
  assert.deepEqual(submitted, [['DOWNLOAD','D:\\downloads','/srv/files/中文.txt']]);
  f.directory.accessKey = 'changed'; let connections = 0;
  await runTerminalTransfer(request, {valid: () => terminalUploadMatches(f.runtime, request),connect: async () => {connections++;return true;},transfer: async () => true});
  assert.equal(connections, 0);
  for (const name of ['..','folder/file','bad\n']) assert.throws(() => createSidebarTransfer(f.runtime,'tab','WSL','/srv', ['D:\\out'],name));
});

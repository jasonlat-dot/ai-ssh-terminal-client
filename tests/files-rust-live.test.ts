import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { uploadFile, readUploadedFile, listUploadedFiles, readFileStorageStats, deleteUploadedFile } from '../src/api/files.ts';
import { FileUploadQueue } from '../src/state/fileUploads.ts';

test('front-end APIs and queue round-trip against the actual Rust attachment server', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shellpilot-files-live-'));
  const executable = resolve('../ai-ssh-terminal-server-rust/target/debug/shellpilot-server.exe');
  const child = spawn(executable, [], {
    windowsHide: true,
    env: { ...process.env, SHELLPILOT_DATA_DIR: directory, SHELLPILOT_PORT: '0', SHELLPILOT_FILE_LINK_SECONDS: '2', RUST_LOG: 'info', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  try {
    const deadline = Date.now() + 10_000;
    let base = '';
    while (Date.now() < deadline) {
      const text = output.replace(/\u001b\[[0-9;]*m/g, '');
      const match = text.split(/\r?\n/).slice(0, -1).join('\n').match(/address=127\.0\.0\.1:(\d+)/);
      if (match) { base = 'http://127.0.0.1:' + match[1]; break; }
      if (child.exitCode !== null) throw new Error('Rust test server exited: ' + output);
      await delay(20);
    }
    assert.ok(base, 'Rust test server did not report its bound port');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === 'agent-ssh-backend-url-v1' ? base : null } });
    const file = await uploadFile(new File(['abc'], '真实附件.TXT', { type: 'text/plain' }));
    assert.equal(file.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(await (await fetch(file.downloadUrl)).text(), 'abc');
    assert.equal((await readFileStorageStats()).fileCount, 1);
    while (Date.now() <= Date.parse(String(file.urlExpiresAt)) + 50) await delay(30);
    assert.equal((await fetch(file.downloadUrl)).status, 410);
    const refreshed = await readUploadedFile(file.fileId);
    assert.equal(await (await fetch(refreshed.downloadUrl)).text(), 'abc');
    const queue = new FileUploadQueue();
    queue.add([new File(['one'], 'one.txt'), new File(['two'], 'two.txt'), new File(['three'], 'three.txt')]);
    const uploads = Date.now() + 10_000;
    while (queue.getSnapshot().some(item => item.status === 'queued' || item.status === 'uploading')) {
      assert.ok(Date.now() < uploads, 'Live upload queue timed out');
      await delay(20);
    }
    assert.ok(queue.getSnapshot().every(item => item.status === 'success'));
    queue.deactivate();
    const page = await listUploadedFiles();
    assert.equal(page.items.length, 4);
    for (const stored of page.items) await deleteUploadedFile(stored.fileId);
    assert.equal((await readFileStorageStats()).usedBytes, 0);
    await assert.rejects(readUploadedFile(file.fileId), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FILE_DOWNLOAD_NOT_FOUND');
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    const root = resolve(directory);
    assert.ok(root.startsWith(resolve(tmpdir()) + '\\') || root.startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  }
});

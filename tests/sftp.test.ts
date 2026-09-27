import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBytes, mergeTask, remoteChild, remoteParent, transferPercent } from '../src/state/sftp.ts';
import type { SftpProgress, SftpTransfer } from '../src/api/sftp.ts';

test('remote navigation stays inside the session root and uses POSIX separators', () => {
  assert.equal(remoteParent('/opt/apps/a', '/opt/apps'), '/opt/apps');
  assert.equal(remoteParent('/opt/apps', '/opt/apps'), null);
  assert.equal(remoteParent('/opt', '/opt/apps'), null);
  assert.equal(remoteParent('/opt', '/'), '/');
  assert.equal(remoteParent('/', '/'), null);
  assert.equal(remoteChild('/', '目录'), '/目录');
  for (const name of ['..', '.', '', 'a/b', 'a\\b', 'a*', 'a?', 'a\n']) assert.throws(() => remoteChild('/opt', name));
});
test('zero-byte transfers use item status; reaching 100% bytes is not completion', () => {
  const progress = { status: 'AWAITING_CONFIRMATION', totalBytes: 0, transferredBytes: 0 } as SftpProgress;
  assert.equal(transferPercent(progress), null);
  assert.equal(transferPercent({ ...progress, status: 'COMPLETED' }), 100);
  assert.equal(transferPercent({ ...progress, totalBytes: 5, transferredBytes: 8 }), 100);
  assert.equal(progress.status, 'AWAITING_CONFIRMATION');
  assert.equal(formatBytes(0), '0 B');
});
test('late task responses cannot replace newer SSE progress', () => {
  const make = (updatedAt: string) => ({ transferId: 'one', progress: { updatedAt } }) as SftpTransfer;
  const newer = make('2026-09-27T12:01:00Z');
  const older = make('2026-09-27T12:00:00Z');
  assert.deepEqual(mergeTask([newer], older), [newer]);
  assert.deepEqual(mergeTask([older], newer), [newer]);
  assert.deepEqual(mergeTask([], older), [older]);
});

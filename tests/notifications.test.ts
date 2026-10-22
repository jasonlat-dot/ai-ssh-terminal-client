import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { beginNotice, dismissNotice, notify, readNotices } from '../src/state/notifications';

beforeEach(() => { for (const notice of readNotices()) dismissNotice(notice.id); });

test('操作结果原位替换进行中提示，完成后的 finally 不删结果，结果恢复自动关闭', () => {
  const pending = beginNotice('正在重连', { key: 'terminal:one' });
  const id = readNotices()[0].id;
  assert.equal(readNotices()[0].durationMs, 0);
  pending.finish('连接成功', 'success'); pending();
  assert.equal(readNotices().length, 1);
  assert.equal(readNotices()[0].id, id);
  assert.equal(readNotices()[0].message, '连接成功');
  assert.equal(readNotices()[0].durationMs, 3500);
  pending.finish('过期失败', 'error');
  assert.equal(readNotices()[0].type, 'success');
});

test('取消立即移除进行中提示，迟到回执不能复活；失败后取消不删除错误反馈', () => {
  const cancelled = beginNotice('正在重连');
  cancelled(); cancelled.finish('过期成功');
  assert.equal(readNotices().length, 0);
  const failed = beginNotice('正在重连');
  failed.finish('认证失败', 'error'); failed();
  assert.equal(readNotices()[0].message, '认证失败');
  assert.equal(readNotices()[0].durationMs, 6000);
});

test('同终端重试共用提示，不同终端隔离，旧请求无法关闭或覆盖新提示', () => {
  const old = beginNotice('第一次重试', { key: 'terminal:one' });
  const firstId = readNotices()[0].id;
  const other = beginNotice('另一个终端', { key: 'terminal:two' });
  const current = beginNotice('第二次重试', { key: 'terminal:one' });
  old(); old.finish('旧请求失败', 'error');
  assert.equal(readNotices().length, 2);
  current.finish('重新连接成功'); current(); other();
  assert.equal(readNotices().length, 1);
  assert.equal(readNotices()[0].id, firstId);
  assert.equal(readNotices()[0].message, '重新连接成功');
});

test('用户主动关闭的提示不被迟到结果重新弹出，普通通知仍保留原有去重行为', () => {
  const pending = beginNotice('正在重连'); dismissNotice(readNotices()[0].id);
  pending.finish('连接成功'); assert.equal(readNotices().length, 0);
  notify('已复制', 'success'); notify('已复制', 'success');
  assert.equal(readNotices().length, 1);
});

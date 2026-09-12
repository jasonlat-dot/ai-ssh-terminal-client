const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const calls = [];
  const errors = [];
  let fail = true;
  const row = { connectionId: 'host-1', connectionName: '我的虚拟机', host: '192.168.1.10', username: 'root', port: 22, authType: 1, status: 1, userId: 'default' };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/ssh/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.split('/').pop();
    if (url.pathname.includes('/terminal/')) {
      return route.fulfill({ json: { code: 'SUCCESS_0000', data: endpoint === 'open'
        ? { sessionId: 'mock-shell', connectionId: 'mock-host', initialOutput: 'ready\r\n' }
        : endpoint === 'read' ? { status: 'TIMEOUT', output: '', hasData: false, connected: true, eof: false, timeout: true, bufferOverflow: false }
        : endpoint === 'exec' ? { output: '' } : null } });
    }

    if (endpoint === 'disconnect') {
      calls.push(url.searchParams.get('connectionId'));
      assert.equal(request.method(), 'POST');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (fail) { fail = false; return route.fulfill({ json: { code: 'ERROR_0001', info: '断开连接失败' } }); }
      row.status = 0;
    }
    if (endpoint === 'connect') row.status = 1;
    await route.fulfill({ json: { code: 'SUCCESS_0000', data: endpoint === 'connection_list' ? [row] : null } });
  });
  const click = name => page.getByRole('button', { name, exact: true }).click();
  const modal = page.getByRole('dialog', { name: '确认断开当前连接？' });
  const open = () => click('关闭 我的虚拟机');
  try {
    await page.goto(process.env.AGENT_SSH_URL || 'http://127.0.0.1:1420');
    await click('进入终端');
    // Closing an inactive remote tab must target its host, not the active local tab.
    await page.getByRole('tab', { name: '本地终端', exact: true }).click();
    await open();
    await modal.waitFor();
    assert.equal(await page.getByRole('checkbox', { name: /同时结束关联/ }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: /保留连接记录/ }).isChecked(), true);
    await click('取消');
    assert.equal(calls.length, 0);
    await open(); await click('稍后处理');
    assert.equal(calls.length, 0);
    await open(); await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    assert.equal(calls.length, 0);
    await open(); await click('关闭弹窗');
    assert.equal(calls.length, 0);
    await page.getByRole('tab', { name: '我的虚拟机', exact: true }).click();
    await open();
    await modal.waitFor();
    const output = process.env.DISCONNECT_QA_DIR || path.join(require('node:os').tmpdir(), 'agent-ssh-disconnect-qa');
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'disconnect-1440.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(output, 'disconnect-1280.png') });
    const box = await modal.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800);
    await click('确认断开');
    assert.equal(await page.getByRole('button', { name: '正在断开…' }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await modal.isVisible(), true);
    await page.locator('.disconnect-error').filter({ hasText: '断开连接失败' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '我的虚拟机', exact: true }).count(), 1);
    assert.deepEqual(calls, ['host-1']);
    await click('确认断开');
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('tab', { name: '我的虚拟机', exact: true }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: '本地终端', exact: true }).getAttribute('aria-selected'), 'true');
    assert.deepEqual(calls, ['host-1', 'host-1']);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('agent-ssh-disconnect-history-v1:default')));
    assert.equal(history.length, 1); assert.equal(history[0].hostId, 'host-1');
    assert.deepEqual(Object.keys(history[0]).sort(), ['address', 'disconnectedAt', 'hostId', 'id', 'name']);
    await click('应用设置');
    await page.getByRole('region', { name: '连接记录' }).getByText('我的虚拟机', { exact: true }).waitFor();
    await click('关闭弹窗');
    await click('连接');
    await click('连接并进入');
    await open();
    await page.getByRole('checkbox', { name: /同时结束关联/ }).uncheck();
    await page.getByRole('checkbox', { name: /保留连接记录/ }).uncheck();
    await click('确认断开');
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('agent-ssh-disconnect-history-v1:default')).length), 1);
    await click('关闭 本地终端');
    assert.equal(await modal.count(), 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(errors, []);
    console.log(`PASS: cancel/defer/Escape, inactive tab target, request lock, failure/retry, history options, local close, 1280px layout. Screenshots: ${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

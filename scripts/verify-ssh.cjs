// Run against a running Vite server. All SSH traffic is intercepted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const calls = [];
  const errors = [];
  let rows = [];
  let failList = true;
  let failSave = false;
  let listHttpError = false;
  let listNetworkError = false;
  let failConnect = true;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/ssh/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.split('/').pop();
    if (url.pathname.includes('/terminal/')) {
      return route.fulfill({ json: { code: 'SUCCESS_0000', data: endpoint === 'open'
        ? { sessionId: 'mock-shell', connectionId: 'mock-host', initialOutput: 'ready\r\n' }
        : endpoint === 'read' || endpoint === 'exec' ? { output: '' } : null } });
    }

    const body = request.postDataJSON();
    calls.push({ endpoint, method: request.method(), body, id: url.searchParams.get('connectionId') });
    const success = data => route.fulfill({ json: { code: 'SUCCESS_0000', info: '成功', data } });
    const failure = info => route.fulfill({ json: { code: 'ERROR_0001', info } });
    if (endpoint === 'connection_list') {
      if (listHttpError) { listHttpError = false; return route.fulfill({ status: 503, body: 'Unavailable' }); }
      if (listNetworkError) { listNetworkError = false; return route.abort(); }
      assert.equal(request.method(), 'GET');
      assert.equal(url.searchParams.get('userId'), 'default');
      if (failList) { failList = false; return failure('列表读取失败'); }
      return success(rows);
    }
    if (endpoint === 'create_connection' || endpoint === 'update_connection') {
      assert.equal(request.method(), 'POST');
      assert.match(request.headers()['content-type'], /application\/json/);
      assert.equal(body.userId, 'default');
      if (failSave) { failSave = false; return failure('保存失败，请重试'); }
      const row = { ...body, connectionId: body.connectionId || `server-id-${rows.length + 1}`, status: 0 };
      delete row.password; delete row.privateKey;
      rows = [...rows.filter(item => item.connectionId !== row.connectionId), row];
      return success(row);
    }
    const id = url.searchParams.get('connectionId');
    assert.ok(id, 'single-connection endpoint requires a query parameter');
    assert.equal(body, null, 'single-connection operations do not send JSON');
    const row = rows.find(item => item.connectionId === id);
    if (endpoint === 'get_connection') { assert.equal(request.method(), 'GET'); return success(row); }
    assert.equal(request.method(), 'POST');
    if (endpoint === 'connect') {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (failConnect) { failConnect = false; return failure('认证失败'); }
      row.status = 1;
    }
    if (endpoint === 'disconnect') row.status = 0;
    if (endpoint === 'delete_connection') rows = rows.filter(item => item.connectionId !== id);
    return success(null);
  });
  const click = name => page.getByRole('button', { name, exact: true }).click();
  const visible = text => page.getByText(text, { exact: true }).first().waitFor();
  try {
    await page.goto(process.env.AGENT_SSH_URL || 'http://127.0.0.1:1420');
    await visible('列表读取失败');
    assert.equal(await page.locator('.ssh-host-card').count(), 0);
    await click('刷新连接');
    await visible('暂无匹配的连接');
    await page.getByRole('button', { name: '新建连接', exact: true }).first().click();
    await page.getByLabel('连接名称', { exact: true }).fill('QA 主机');
    await page.getByLabel('主机地址', { exact: true }).fill('qa.example.test');
    await click('保存连接');
    await visible('请填写 SSH 密码。');
    await page.getByLabel('SSH 密码', { exact: true }).fill('test-only-password');
    await page.getByLabel('连接超时（秒）').fill('20');
    failSave = true;
    await click('保存连接');
    await visible('保存失败，请重试');
    assert.equal(await page.getByLabel('SSH 密码', { exact: true }).inputValue(), 'test-only-password');
    await click('保存连接');
    await page.locator('.ssh-host-card').waitFor();
    assert.equal(rows[0].connectionId, 'server-id-1');
    assert.equal(calls.find(item => item.endpoint === 'create_connection').body.connectTimeout, 20);
    await click('编辑');
    await page.getByLabel('连接名称', { exact: true }).fill('QA 已编辑');
    assert.equal(await page.getByLabel('SSH 密码', { exact: true }).inputValue(), '');
    await click('保存连接');
    await visible('QA 已编辑');
    const update = calls.find(item => item.endpoint === 'update_connection').body;
    assert.equal(update.connectionId, 'server-id-1');
    assert.ok(!('password' in update) && !('connectTimeout' in update));
    await click('连接并进入');
    await visible('认证失败');
    await visible('连接失败');
    await click('连接并进入');
    await page.getByRole('tab', { name: 'QA 已编辑' }).waitFor();
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await click('断开');
    await page.locator('.host-status').filter({ hasText: '未连接' }).waitFor();
    await click('编辑');
    await page.getByLabel('认证方式', { exact: true }).selectOption('key');
    await click('保存连接');
    await visible('请填写私钥内容。');
    await page.getByLabel('私钥内容', { exact: true }).fill('test-only-private-key');
    await click('保存连接');
    await page.getByLabel('编辑 SSH 连接', { exact: true }).waitFor({ state: 'hidden' });
    const keyUpdate = calls.filter(item => item.endpoint === 'update_connection').at(-1).body;
    assert.equal(keyUpdate.authType, 2); assert.equal(keyUpdate.privateKey, 'test-only-private-key');
    await click('编辑');
    await page.getByLabel('认证方式', { exact: true }).selectOption('password');
    await click('保存连接');
    await visible('当前接口无法清除已有私钥，请新建密码认证连接。');
    await click('取消');
    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    assert.ok(!storage.includes('test-only-password') && !storage.includes('test-only-private-key'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await click('删除');
    await click('确认删除');
    await visible('暂无匹配的连接');
    assert.equal(rows.length, 0);
    assert.equal(calls.at(-2).endpoint, 'disconnect');
    assert.equal(calls.at(-1).endpoint, 'delete_connection');
    listHttpError = true;
    await click('刷新连接');
    await visible('SSH 服务请求失败（HTTP 503）');
    listNetworkError = true;
    await click('刷新连接');
    await visible('无法访问 SSH 服务，请检查后端地址和网络连接。');
    await click('刷新连接');
    await visible('暂无匹配的连接');
    assert.deepEqual(errors, []);
    console.log('PASS: all 7 endpoints, retry/error handling, credentials, edit preservation, server IDs, connect/disconnect/delete, no credential persistence, 1280px layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

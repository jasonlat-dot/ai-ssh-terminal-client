const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const calls = [], errors = [];
  let output = '', failOpen = true, failExec = true, failRead = false, failClose = true;
  let draining = false;
  const row = { connectionId: 'host-one', connectionName: '真实终端测试', host: 'example.test', port: 22, username: 'root', status: 1, authType: 1, userId: 'default' };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/ssh/**', async route => {
    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.split('/').pop();
    const body = req.postDataJSON();
    const ok = data => route.fulfill({ json: { code: 'SUCCESS_0000', data } });
    const fail = info => route.fulfill({ json: { code: 'ERROR_0001', info } });
    calls.push({ endpoint, body });
    if (!url.pathname.includes('/terminal/')) {
      if (endpoint === 'connection_list') return ok([row]);
      if (endpoint === 'disconnect') { row.status = 0; return ok(null); }
      return ok(null);
    }
    if (endpoint === 'open') {
      assert.equal(req.method(), 'POST'); assert.equal(body.connectionId, 'host-one');
      assert.ok(body.cols > 0 && body.rows > 0);
      if (failOpen) { failOpen = false; return fail('打开失败测试'); }
      return ok({ sessionId: 'server-shell-id', connectionId: 'host-one', initialOutput: '\x1b[32mWELCOME_TEST\x1b[0m\r\nHISTORY_BEFORE_VIM\r\nroot@test:~$ ' });
    }
    if (endpoint === 'read' || endpoint === 'close') {
      assert.equal(url.searchParams.get('sessionId'), 'server-shell-id');
      assert.equal(req.method(), endpoint === 'read' ? 'GET' : 'POST'); assert.equal(body, null);
    } else { assert.equal(req.method(), 'POST'); assert.equal(body.sessionId, 'server-shell-id'); }
    if (endpoint === 'read') {
      assert.equal(draining, false, 'read must not race exec drain');
      if (failRead) { failRead = false; return fail('读取失败测试'); }
      const data = output; output = ''; return ok({ output: data });
    }
    if (endpoint === 'exec') {
      assert.equal(body.command, 'pwd\r');
      if (failExec) { failExec = false; return fail('提交失败测试'); }
      draining = true; await new Promise(resolve => setTimeout(resolve, 350)); draining = false;
      output = '\r\nLATE_OUTPUT_TEST\r\nroot@test:~$ ';
      return ok({ output: '\r\n/home/test\r\n' });
    }
    if (endpoint === 'resize') { assert.ok(body.cols > 0 && body.rows > 0); return ok(null); }
    if (endpoint === 'write') { output += '\r\nWRITE_ACK\r\n'; return ok(null); }
    if (endpoint === 'close') { if (failClose) { failClose = false; return fail('关闭失败测试'); } return ok(null); }
    throw new Error(endpoint);
  });
  const click = name => page.getByRole('button', { name, exact: true }).click();
  const terminalText = text => page.locator('.xterm-rows').getByText(text, { exact: false }).first().waitFor();
  try {
    await page.goto(process.env.AGENT_SSH_URL || 'http://127.0.0.1:1420');
    await click('进入终端'); await page.getByText('打开失败测试', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: row.connectionName }).count(), 0);
    await click('进入终端');
    await terminalText('WELCOME_TEST');
    // Vim uses DECSET 1049 for its alternate buffer. Leaving it must restore shell history.
    output = '\x1b[?1049h\x1b[H\x1b[2JVIM_FILE_CONTENT\r\n~\r\n~\r\n~';
    await terminalText('VIM_FILE_CONTENT');
    output = '\x1b[?1049l';
    await terminalText('HISTORY_BEFORE_VIM');
    assert.equal(await page.locator('.xterm-rows').getByText('VIM_FILE_CONTENT', { exact: false }).count(), 0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'ssh-terminal-real-qa.png') });
    const input = page.getByRole('textbox', { name: '终端命令输入', exact: true });
    await input.fill('pwd'); await input.press('Enter');
    await page.getByText('此命令将在远程主机实际执行，请确认命令内容。').waitFor();
    assert.equal(calls.filter(call => call.endpoint === 'exec').length, 0);
    await click('确认执行'); await page.getByText(/提交失败测试；未自动重试/).waitFor();
    await input.fill('pwd'); await input.press('Enter'); await click('确认执行');
    await terminalText('/home/test'); await terminalText('LATE_OUTPUT_TEST');
    // Local tab switching must preserve the same server session and screen.
    await page.getByRole('tab', { name: '本地终端', exact: true }).click();
    await page.getByRole('tab', { name: row.connectionName, exact: true }).click();
    await terminalText('WELCOME_TEST');
    assert.equal(calls.filter(call => call.endpoint === 'open').length, 2);
    await click('中断 Ctrl+C');
    await terminalText('WRITE_ACK');
    assert.equal(calls.find(call => call.endpoint === 'write').body.input, '\x03');
    // Direct terminal input remains available while command confirmation is enabled.
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('ls'); await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    assert.ok(calls.filter(call => call.endpoint === 'write').some(call => call.body.input.includes('l')));
    // A dead server channel must stop polling and offer a full SSH + terminal reconnect.
    output = '\x1b[31m\r\n[连接已断开]\x1b[0m\r\n';
    await page.getByRole('alert').filter({ hasText: '与服务器的连接已断开' }).waitFor();
    const disconnectedReads = calls.filter(call => call.endpoint === 'read').length;
    await page.waitForTimeout(600);
    assert.equal(calls.filter(call => call.endpoint === 'read').length, disconnectedReads);
    await click('重新连接');
    await terminalText('WELCOME_TEST');
    assert.equal(calls.filter(call => call.endpoint === 'connect').length, 1);
    assert.equal(calls.filter(call => call.endpoint === 'open').length, 3);
    assert.equal(await page.getByRole('button', { name: '重新连接', exact: true }).count(), 0);
    const resizes = calls.filter(call => call.endpoint === 'resize').length;
    await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(500);
    assert.ok(calls.filter(call => call.endpoint === 'resize').length > resizes);
    failRead = true;
    await page.getByRole('alert').filter({ hasText: '读取失败测试' }).waitFor();
    const reads = calls.filter(call => call.endpoint === 'read').length;
    await page.waitForTimeout(600); assert.equal(calls.filter(call => call.endpoint === 'read').length, reads);
    await click('重试读取'); await page.waitForTimeout(400);
    assert.ok(calls.filter(call => call.endpoint === 'read').length > reads);
    await click(`关闭 ${row.connectionName}`); await click('确认断开');
    await page.locator('.disconnect-error').filter({ hasText: '关闭失败测试' }).waitFor();
    assert.equal(calls.filter(call => call.endpoint === 'disconnect').length, 0);
    await click('确认断开');
    await page.getByRole('dialog', { name: '确认断开当前连接？' }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('tab', { name: row.connectionName }).count(), 0);
    assert.ok(calls.findLastIndex(call => call.endpoint === 'close') < calls.findIndex(call => call.endpoint === 'disconnect'));
    assert.deepEqual(errors, []);
    console.log('PASS terminal 7 endpoints: open/retry, ANSI/initial/delayed output, Vim alternate-buffer restoration, exec newline/confirmation, ordered read, raw input/Ctrl+C, dropped-session detection/reconnect, resize, tab persistence, read retry, close failure/retry and disconnect ordering.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

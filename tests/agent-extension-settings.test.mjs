import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const apiContext = vm.createContext({ exports: {}, require: name => name === './builtin' ? { builtinRequest() { throw new Error('unexpected network'); } } : { sshUserId: 'default' } });
vm.runInContext(compile('../src/api/agentExtensions.ts'), apiContext);
const defaults = JSON.parse(JSON.stringify(apiContext.exports.defaultExecutionLimits));
const mcpContext = vm.createContext({ exports: {}, Error, URL });
vm.runInContext(compile('../src/state/mcpConfig.ts'), mcpContext);
const { parseMcpConfig, formatMcpConfig, savedMcpValue } = mcpContext.exports;
const skillsContext = vm.createContext({ exports: {}, Error, TextEncoder });
vm.runInContext(compile('../src/state/skillDirectories.ts'), skillsContext);
const output = compile('../src/components/AgentExtensionSettings.tsx');
const clone = value => JSON.parse(JSON.stringify(value));
function harness(initial, options = {}) {
  const slots = [], effects = [], saved = [], notices = []; let cursor = 0;
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useEffect(effect, deps) { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index][i])) { slots[index] = deps; effects.push(effect); } },
  };
  const context = vm.createContext({ exports: {}, Error, Number, Object, String, URL, document: { body: {} },
    require(name) {
      if (name === '../state/notifications') return { notify: (message, type) => notices.push({ message, type }) };
      if (name === 'react') return hooks;
      if (name === 'react-dom') return { createPortal: node => node };
      if (name === './JsonCodeEditor') return { JsonCodeEditor: 'json-editor' };
      if (name === './Ui') return { Modal: 'modal', Icon: 'icon' };
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === '../state/mcpConfig') return mcpContext.exports;
      if (name === '../state/skillDirectories') return skillsContext.exports;
      if (name === './Select') return { Select: 'preset-select' };
      if (name === '../api/agentExtensions') return { defaultExecutionLimits: defaults, extensionApi: { settings: async () => { if (options.failLoad) throw new Error('读取失败'); return clone(initial); }, save: async value => { saved.push(clone(value)); if (options.failSave) throw new Error('设置已变化'); return { ...value, config: { ...value.config, servers: value.config.servers.map(server => {
        const { connectionValues, bearerToken, ...savedServer } = server;
        return { ...savedServer, ...(connectionValues ? { savedHeaders: Object.keys(connectionValues.headers).map(key=>key.toLowerCase()), savedEnv: Object.keys(connectionValues.env) } : {}), ...(bearerToken ? { bearerTokenConfigured: bearerToken.action === 'set' } : {}) };
      }) }, revision: value.revision + 1 }; } } };
      if (name === './Ui' || name.endsWith('.css')) return {};
      throw new Error(name);
    },
  });
  vm.runInContext(output, context);
  return { saved, notices, parse: context.exports.parseExecutionLimits, render(locked = false) { cursor = 0; return context.exports.AgentExtensionSettings({ locked }); }, async flush() { while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); } };
}
function all(node) { if (Array.isArray(node)) return node.flatMap(all); return node?.props ? [node, ...all(node.props.children)] : []; }
function text(node) { if (Array.isArray(node)) return node.map(text).join(' '); return node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
const fixture = () => ({ revision: 3, config: { executionLimits: { ...defaults }, servers: [{ name: 'docs', enabled: true, transport: 'streamableHttp', url: 'https://example.com/mcp', bearerEnv: 'TOKEN' }], skillRoots: ['C:\\Skills'], subAgents: true } });
async function loaded(options) { const h = harness(fixture(), options); h.render(); await h.flush(); return h; }
const submit = tree => (all(tree).find(node => node.props.className?.includes('config-form')) ?? all(tree).find(node => node.type === 'form')).props.onSubmit({ preventDefault() {} });

test('Execution settings save all five edited limits and preserve MCP, Skills and revision', async () => {
  const h = await loaded(); let tree = h.render();
  const inputs = all(tree).filter(node => node.type === 'input' && node.props.type === 'number');
  assert.equal(inputs.length, 5);
  for (const [index, value] of ['48', '256', '12', '32', '4'].entries()) inputs[index].props.onChange({ target: { value } });
  tree = h.render(); submit(tree); await h.flush();
  assert.deepEqual(h.saved[0], { ...fixture(), config: { ...fixture().config, executionLimits: { modelRounds: 48, toolCalls: 256, childModelRounds: 12, childToolCalls: 32, maxChildTasks: 4 } } });
  assert.match(h.notices.at(-1).message, /已保存，下次发送消息时生效/);
  assert.equal(h.notices.at(-1).type, 'success');
  assert.doesNotMatch(text(h.render()), /设置已保存/);
});

test('Restoring recommendations updates every limit without deleting service or skill settings', async () => {
  const custom = fixture(); custom.config.executionLimits.modelRounds = 60; custom.config.executionLimits.maxChildTasks = 2;
  const h = harness(custom); h.render(); await h.flush(); let tree = h.render();
  all(tree).find(node => node.type === 'button' && text(node) === '恢复推荐值').props.onClick();
  tree = h.render(); submit(tree); await h.flush();
  assert.deepEqual(h.saved[0].config.executionLimits, defaults);
  assert.deepEqual(h.saved[0].config.servers, custom.config.servers); assert.deepEqual(h.saved[0].config.skillRoots, custom.config.skillRoots);
});

test('Invalid blank, fractional and out of range quotas cannot be saved', async () => {
  for (const value of ['', '1', '257', '2.5', 'abc']) {
    const h = await loaded(); let tree = h.render();
    all(tree).find(node => node.props['aria-label'] === '主对话模型请求轮数').props.onChange({ target: { value } });
    submit(h.render()); await h.flush(); assert.equal(h.saved.length, 0); assert.match(text(h.render()), /2–256/);
  }
});

test('Locked settings block saving and show the quota explanation and separate semantic sections', async () => {
  const h = await loaded(); const tree = h.render(true);
  assert.equal(all(tree).find(node => node.type === 'fieldset').props.disabled, true);
  assert.equal(all(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  submit(tree); await h.flush(); assert.equal(h.saved.length, 0);
  assert.equal(all(tree).filter(node => node.type === 'section').length, 4);
  assert.match(text(tree), /不占工具调用次数/); assert.match(text(tree), /仍计入模型轮数/);
  assert.equal(all(tree).filter(node => node.type === 'footer').length, 1);
});

test('Load and save failures stay visible without claiming the configuration was saved', async () => {
  const broken = harness(fixture(), { failLoad: true }); broken.render(); await broken.flush(); assert.match(text(broken.render()), /读取失败/);
  const h = await loaded({ failSave: true }); submit(h.render()); await h.flush(); assert.match(text(h.render()), /设置已变化/); assert.doesNotMatch(text(h.render()), /已保存，下一次/);
});

test('Legacy settings without quota fields receive the recommended defaults on save', async () => {
  const old = fixture(); delete old.config.executionLimits;
  const h = harness(old); h.render(); await h.flush(); submit(h.render()); await h.flush();
  assert.deepEqual(h.saved[0].config.executionLimits, defaults);
});

test('All five quota controls provide common presets, recommended markers and integer saves', async () => {
  const h = await loaded(); let tree = h.render();
  const menus = all(tree).filter(node => node.type === 'preset-select');
  assert.equal(menus.length, 5);
  for (const menu of menus) {
    assert.match(menu.props.label, /常用档位$/);
    assert.equal(menu.props.className, 'model-token-presets');
    assert.equal(menu.props.menuClassName, 'model-token-menu');
    assert.ok(menu.props.options.some(option => option.description === '推荐'));
    assert.ok(menu.props.options.length >= 6);
  }
  for (const [index, value] of ['64', '256', '48', '128', '8'].entries()) menus[index].props.onChange(value);
  tree = h.render(); submit(tree); await h.flush();
  assert.deepEqual(h.saved[0].config.executionLimits, { modelRounds: 64, toolCalls: 256, childModelRounds: 48, childToolCalls: 128, maxChildTasks: 8 });
});

test('A manually typed quota outside presets stays custom and is not rounded to a common choice', async () => {
  const h = await loaded(); let tree = h.render();
  all(tree).find(node => node.type === 'input' && node.props['aria-label'] === '主对话模型请求轮数').props.onChange({ target: { value: '37' } });
  tree = h.render();
  const menu = all(tree).find(node => node.type === 'preset-select');
  assert.equal(menu.props.value, '37'); assert.equal(menu.props.displayValue, '自定义');
  assert.equal(menu.props.options[0].value, '37');
  submit(tree); await h.flush(); assert.equal(h.saved[0].config.executionLimits.modelRounds, 37);
});

const skillsInputs = h => all(h.render()).filter(node => node.type === 'input' && /^技能目录 \d+$/.test(node.props['aria-label'] ?? ''));
const openSkills = h => {
  all(h.render()).find(node=>node.type==='button' && text(node).trim()==='配置 Skills').props.onClick();
};

test('Skills page hides paths and editing controls until configured in a dialog with separate highlighted rows', async () => {
  const initial=fixture();initial.config.skillRoots=['C:/Skills/one','D:/Skills/two'];
  const h=harness(initial);h.render();await h.flush();
  assert.equal(all(h.render()).filter(node=>node.type==='textarea').length,0);
  assert.ok(!text(h.render()).includes('C:/Skills/one'));assert.match(text(h.render()),/已配置 2 个技能目录/);
  openSkills(h);let inputs=skillsInputs(h);assert.equal(inputs.length,2);
  assert.equal(inputs[0].props.value,'C:/Skills/one');assert.equal(inputs[1].props.value,'D:/Skills/two');
  assert.equal(all(h.render()).filter(node=>node.props.className==='skills-directory-row').length,2);
  inputs[1].props.onChange({target:{value:' D:/Skills/three '}});
  submit(h.render());await h.flush();
  assert.deepEqual(h.saved[0].config.skillRoots,['C:/Skills/one','D:/Skills/three']);
  assert.equal(skillsInputs(h).length,0);assert.match(h.notices.at(-1).message,/Skills 目录已保存/);
});

const editor = h => {
  if (!all(h.render()).some(node=>node.type==='json-editor')) all(h.render()).find(node=>node.type==='button' && text(node).trim()==='配置 MCP').props.onClick();
  return all(h.render()).find(node=>node.type==='json-editor');
};
const editJson = (h, root) => editor(h).props.onChange(typeof root === 'string' ? root : JSON.stringify(root));

test('JSON editor saves multiple services together with custom headers and stdio env, then redacts stored values', async () => {
  const h=await loaded();
  const document={mcpServers:{'aisearch-mcp-server':{type:'streamableHttp',description:'搜索实时信息',baseUrl:'https://qianfan.baidubce.com/v2/ai_search/mcp',headers:{Authorization:'Bearer fixture-token','X-API-Key':'fixture-key'}},local:{command:'node',args:['C:/mcp/server.js'],env:{ACCESS_KEY:'fixture-env'}}}};
  editJson(h,document); submit(h.render()); await h.flush();
  assert.equal(h.saved[0].config.servers.length,2);
  assert.equal(h.saved[0].config.servers[0].description,'搜索实时信息');
  assert.equal(h.saved[0].config.servers[0].url,document.mcpServers['aisearch-mcp-server'].baseUrl);
  assert.deepEqual(h.saved[0].config.servers[0].connectionValues.headers,document.mcpServers['aisearch-mcp-server'].headers);
  assert.deepEqual(h.saved[0].config.servers[1].connectionValues.env,{ACCESS_KEY:'fixture-env'});
  const shown=editor(h).props.value;
  assert.ok(shown.includes(savedMcpValue));assert.ok(!shown.includes('fixture-token'));assert.ok(!shown.includes('fixture-env'));
  submit(h.render());await h.flush();
  assert.equal(h.saved[1].config.servers[0].connectionValues.headers.authorization,savedMcpValue);
  assert.equal(h.saved[1].config.servers[1].connectionValues.env.ACCESS_KEY,savedMcpValue);
});

test('JSON parse failures remain beside editor and preserve draft without echoing credentials', async () => {
  const h=await loaded();const draft='{"mcpServers":{"docs":{"headers":{"Authorization":"Bearer fixture-secret"},}}}';
  editJson(h,draft);submit(h.render());await h.flush();
  assert.equal(h.saved.length,0);assert.equal(editor(h).props.value,draft);assert.equal(editor(h).props.invalid,true);
  const alert=all(h.render()).find(node=>node.props.role==='alert');assert.match(text(alert),/格式错误/);assert.ok(!text(alert).includes('fixture-secret'));
  editJson(h,{mcpServers:{}});assert.equal(editor(h).props.invalid,false);
  submit(h.render());await h.flush();assert.deepEqual(h.saved[0].config.servers,[]);
});

test('Formatting and inserting disabled examples preserve the existing configuration and invalid drafts', async () => {
  const h=await loaded();
  const button=label=>all(h.render()).find(node=>node.type==='button'&&text(node)===label);
  editor(h);button('stdio').props.onClick();button('stdio').props.onClick();
  let root=JSON.parse(editor(h).props.value);
  assert.ok(root.mcpServers.docs);assert.equal(root.mcpServers.filesystem.enabled,false);assert.ok(root.mcpServers['filesystem-2']);
  editJson(h,JSON.stringify(root));button('格式化 JSON').props.onClick();assert.ok(editor(h).props.value.includes('\n  "mcpServers"'));
  editJson(h,'{');button('stdio').props.onClick();assert.equal(editor(h).props.value,'{');assert.match(text(h.render()),/格式错误/);
});

test('Legacy saved tokens become placeholders and HTTP env settings migrate without exposing secrets', async () => {
  const initial=fixture();initial.config.servers[0].bearerTokenConfigured=true;initial.config.servers[0].bearerEnv='';
  const h=harness(initial);h.render();await h.flush();
  assert.equal(JSON.parse(editor(h).props.value).mcpServers.docs.headers.Authorization,savedMcpValue);
  submit(h.render());await h.flush();assert.equal(h.saved[0].config.servers[0].connectionValues.headers.Authorization,savedMcpValue);
});

test('Save failure retains edited JSON credentials without claiming success', async () => {
  const h=await loaded({failSave:true});const draft={mcpServers:{docs:{url:'https://example.com/mcp',headers:{Authorization:'Bearer fixture-private'}}}};
  editJson(h,draft);submit(h.render());await h.flush();
  assert.ok(editor(h).props.value.includes('fixture-private'));assert.match(text(h.render()),/设置已变化/);assert.doesNotMatch(text(h.render()),/已保存，下一次/);
});

test('MCP page shows only the summary and button, and cancel discards the dialog draft', async () => {
  const h=await loaded();
  assert.equal(all(h.render()).filter(node=>node.type==='json-editor'||node.type==='modal').length,0);
  assert.match(text(h.render()),/已配置 1 个服务 · 1 个启用/);
  editJson(h,'{"mcpServers":{}}');
  all(h.render()).find(node=>node.type==='button'&&text(node)==='取消').props.onClick();
  assert.equal(h.saved.length,0);assert.equal(all(h.render()).filter(node=>node.type==='modal').length,0);
  assert.ok(JSON.parse(editor(h).props.value).mcpServers.docs);
});

test('Dialog saves MCP independently while preserving unsaved quotas and subagent changes', async () => {
  const h=await loaded();
  all(h.render()).find(node=>node.props['aria-label']==='主对话模型请求轮数').props.onChange({target:{value:'48'}});
  all(h.render()).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:false}});
  editJson(h,{mcpServers:{}});submit(h.render());await h.flush();
  assert.equal(h.saved[0].config.executionLimits.modelRounds,32);
  assert.deepEqual(h.saved[0].config.skillRoots,fixture().config.skillRoots);assert.equal(h.saved[0].config.subAgents,true);
  assert.deepEqual(h.saved[0].config.servers,[]);
  assert.equal(all(h.render()).find(node=>node.props['aria-label']==='主对话模型请求轮数').props.value,'48');
  submit(h.render());await h.flush();
  assert.equal(h.saved[1].revision,4);assert.equal(h.saved[1].config.executionLimits.modelRounds,48);
  assert.deepEqual(h.saved[1].config.skillRoots,fixture().config.skillRoots);assert.equal(h.saved[1].config.subAgents,false);
});

test('Modal locks background form and supports keyboard format/save, with failed saves kept inside the dialog', async () => {
  const h=await loaded({failSave:true});editor(h);
  assert.equal(all(h.render()).find(node=>node.type==='form').props.inert,true);
  assert.equal(all(h.render()).find(node=>node.props.className==='extension-form-fields').props.disabled,true);
  let prevented=0;
  const hotkey=event=>all(h.render()).find(node=>node.props.className==='mcp-config-form').props.onKeyDown({preventDefault(){prevented++;},ctrlKey:true,metaKey:false,shiftKey:false,...event});
  editJson(h,'{"mcpServers":{}}');hotkey({key:'F',shiftKey:true});assert.match(editor(h).props.value,/\n/);
  hotkey({key:'Enter'});await h.flush();assert.equal(prevented,2);assert.equal(h.saved.length,1);
  const modal=all(h.render()).find(node=>node.type==='modal');assert.ok(modal);
  assert.ok(all(modal).some(node=>node.props.role==='alert'&&/设置已变化/.test(text(node))));
});

test('Skills directory rows support multiline paste, add/remove and cancel without saving', async () => {
  const h=await loaded();openSkills(h);
  let prevented=0;
  skillsInputs(h)[0].props.onPaste({clipboardData:{getData:()=> 'C:/Skills/one\r\nD:/Skills/two\n'},preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.deepEqual(skillsInputs(h).map(node=>node.props.value),['C:/Skills/one','D:/Skills/two']);
  all(h.render()).find(node=>node.type==='button'&&text(node).trim()==='添加目录').props.onClick();
  assert.equal(skillsInputs(h).length,3);
  all(h.render()).find(node=>node.props['aria-label']==='移除技能目录 2').props.onClick();
  assert.deepEqual(skillsInputs(h).map(node=>node.props.value),['C:/Skills/one','']);
  all(h.render()).find(node=>node.type==='modal').props.onClose();
  assert.equal(h.saved.length,0);openSkills(h);assert.equal(skillsInputs(h).length,1);assert.equal(skillsInputs(h)[0].props.value,fixture().config.skillRoots[0]);
});

test('Skills saves independently and preserves quota/subagent drafts and the latest saved MCP revision', async () => {
  const h=await loaded();
  all(h.render()).find(node=>node.props['aria-label']==='主对话模型请求轮数').props.onChange({target:{value:'48'}});
  all(h.render()).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:false}});
  openSkills(h);skillsInputs(h)[0].props.onChange({target:{value:'C:/NewSkills'}});
  submit(h.render());await h.flush();
  assert.deepEqual(h.saved[0].config.skillRoots,['C:/NewSkills']);
  assert.equal(h.saved[0].config.executionLimits.modelRounds,32);assert.equal(h.saved[0].config.subAgents,true);
  assert.deepEqual(h.saved[0].config.servers,fixture().config.servers);
  assert.equal(all(h.render()).find(node=>node.props['aria-label']==='主对话模型请求轮数').props.value,'48');
  editJson(h,{mcpServers:{}});submit(h.render());await h.flush();
  assert.equal(h.saved[1].revision,4);assert.deepEqual(h.saved[1].config.skillRoots,['C:/NewSkills']);
  assert.equal(h.saved[1].config.executionLimits.modelRounds,32);
  submit(h.render());await h.flush();
  assert.equal(h.saved[2].revision,5);assert.equal(h.saved[2].config.executionLimits.modelRounds,48);assert.equal(h.saved[2].config.subAgents,false);
});

test('Skills validates the indicated row, bounds multiline paste, preserves failed drafts and can clear all directories', async () => {
  const h=await loaded();openSkills(h);
  skillsInputs(h)[0].props.onChange({target:{value:'relative/path'}});submit(h.render());await h.flush();
  assert.equal(h.saved.length,0);assert.match(text(h.render()),/第 1 个目录须为本机绝对路径/);
  assert.equal(skillsInputs(h)[0].props['aria-invalid'],true);
  skillsInputs(h)[0].props.onPaste({clipboardData:{getData:()=>Array.from({length:17},(_,i)=>`C:/Skills/${i}`).join('\n')},preventDefault(){}});
  assert.match(text(h.render()),/最多配置 16/);assert.equal(skillsInputs(h).length,1);
  all(h.render()).find(node=>node.props['aria-label']==='移除技能目录 1').props.onClick();submit(h.render());await h.flush();
  assert.deepEqual(h.saved[0].config.skillRoots,[]);
  const failed=await loaded({failSave:true});openSkills(failed);skillsInputs(failed)[0].props.onChange({target:{value:'C:/KeepDraft'}});
  submit(failed.render());await failed.flush();assert.equal(skillsInputs(failed)[0].props.value,'C:/KeepDraft');
  assert.ok(all(all(failed.render()).find(node=>node.type==='modal')).some(node=>node.props.role==='alert'&&/设置已变化/.test(text(node))));
});

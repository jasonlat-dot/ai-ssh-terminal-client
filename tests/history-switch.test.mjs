import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { restoreProjectConversation } from '../src/state/projectConversation.ts';
import { readAgentHistory, turnMessages } from '../src/state/agentHistory.ts';
import { ConversationRuns } from '../src/state/conversationRuns.ts';

// Exercise the real sidebar orchestration and history loader together. Testing
// these separately misses a lock acquired by the caller blocking its own load.
const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['loadChatSession', 'selectChatSession', 'openProjectChat', 'changeConversationModel']);
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(app))) declarations.push(`const ${node.getText(app)};`);
  ts.forEachChild(node, visit);
}
visit(app);
const compiled = ts.transpileModule(`${declarations.join('\n')}\nexports.actions={selectChatSession,openProjectChat,changeConversationModel};`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const project = { id: 'project', name: 'WSL', connectionId: 'ssh' };
const chat = id => ({ sessionId: id, agentId: 'model', title: id, createdAt: 1 });
function history(id) {
  return { session: { id, agentId: 'model', revision: 2, task: null }, hasMore: false,
    turns: [{ requestId: `${id}-request`, state: 'completed', message: `question ${id}`, resultText: `answer ${id}`, partialText: '', createdAt: 1, updatedAt: 2 }] };
}
function harness(read = async id => history(id)) {
  const state = { session: 'original', messages: [{ text: 'original reply' }], project, loading: '', switching: false, clears: 0, reads: [], connections: [], notices: [] };
  const scopeSwitchRef = { current: false };
  const globals = {
    selectedAgent: { agentId: 'model' }, selectedAgentRef: { current: { agentId: 'model' } }, agentModels: [], skipModelReset: { current: '' },
    chatting: { current: false }, stopPending: { current: false }, scopeSwitchRef, manualCompactionAbort: { current: null }, reasoningSavingRef: { current: false },
    historySelection: { current: 0 }, chatVersion: { current: 0 }, chatSessionId: { current: 'original' }, chatTarget: { current: null },
    rustBuiltin: true, projectLocked: false, historySwitchLocked:false, chatRuns:new ConversationRuns(), readAgentHistory, turnMessages, restoreProjectConversation,
    agentApi: { history: async (model, id) => { state.reads.push({ model, id, locked: scopeSwitchRef.current }); return read(id); } },
    chatDraft: { clear: () => { state.clears++; } },
    setHistoryLoadingId: id => { state.loading = id; }, setCanonicalHistory: value => { state.canonical = value; },
    setActiveChatSessionId: id => { state.session = id; }, replaceMessages: messages => { state.messages = messages; },
    chatAbort:{current:null},chatRequestId:{current:''},setChatBusy(){},setChatStopping(){},setContextSnapshot(){},setContextError(){},
    setSelectedAgent() { assert.fail('same model needs no reset'); },
    setBackendSettingsOpen(){},setScopeSwitching: value => { state.switching = value; }, setAgentCollapsed() {},
    setActiveProject: value => { state.project = value; }, setProjectTerminalId() {},
    connectProject: async value => { state.connections.push(value.id); }, notify: message => { state.notices.push(message); },
  };
  const context = vm.createContext({ exports: {}, Error, ...globals });
  vm.runInContext(compiled, context);
  return { ...context.exports.actions, state, scopeSwitchRef };
}

for (const target of [null, project]) test(`Sidebar opens ${target ? 'project' : 'ungrouped'} history while holding its own switch lock`, async () => {
  const ui = harness();
  await ui.openProjectChat(chat('next'), target);
  assert.equal(ui.state.session, 'next');
  assert.equal(ui.state.messages[1].text, 'answer next');
  assert.equal(ui.state.project, target);
  assert.deepEqual(ui.state.reads, [{ model: 'model', id: 'next', locked: true }]);
  assert.deepEqual(ui.state.connections, target ? ['project'] : []);
  assert.equal(ui.state.clears, 1);
  assert.equal(ui.scopeSwitchRef.current, false);
  assert.equal(ui.state.loading, '');
  assert.equal(ui.state.switching, false);
});

test('Pending sidebar load blocks another history click, refresh and model switch, then unlocks', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = harness(() => pending);
  const opened = ui.openProjectChat(chat('first'), null);
  assert.equal(ui.scopeSwitchRef.current, true);
  await ui.openProjectChat(chat('second'), project);
  await ui.selectChatSession('third', 'model');
  await ui.changeConversationModel('other-model');
  assert.equal(ui.state.reads.length, 1);
  assert.equal(ui.state.session, 'original');
  finish(history('first'));
  await opened;
  assert.equal(ui.state.session, 'first');
  assert.equal(ui.scopeSwitchRef.current, false);
});

test('Failed history load preserves the current conversation and releases the lock for retry', async () => {
  let fail = true;
  const ui = harness(async id => { if (fail) throw Error('history unavailable'); return history(id); });
  await ui.openProjectChat(chat('next'), null);
  assert.equal(ui.state.session, 'original');
  assert.equal(ui.state.messages[0].text, 'original reply');
  assert.equal(ui.state.project, project);
  assert.equal(ui.state.clears, 0);
  assert.deepEqual(ui.state.notices, ['history unavailable']);
  assert.equal(ui.scopeSwitchRef.current, false);
  assert.equal(ui.state.loading, '');
  fail = false;
  await ui.openProjectChat(chat('next'), null);
  assert.equal(ui.state.session, 'next');
});

test('Direct history refresh still loads when no scope switch is active', async () => {
  const ui = harness();
  assert.equal(await ui.selectChatSession('next', 'model'), true);
  assert.equal(ui.state.session, 'next');
  assert.equal(ui.state.reads[0].locked, false);
});

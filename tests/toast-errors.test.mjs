import assert from 'node:assert/strict';
import test from 'node:test';
import { loadToastErrorHooks } from './helpers/toast-errors.mjs';

function harness() {
  const slots = [], notices = [], effects = []; let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((value, index) => value !== slots[i][index])) { slots[i] = deps; effects.push(effect); } },
  };
  const module = loadToastErrorHooks(hooks, (message, type) => notices.push({message, type}));
  return { notices, render(error, external = false) { cursor = 0; return external ? module.useErrorToast(error) : module.useToastError(error); }, flush() { while(effects.length) effects.shift()(); } };
}

test('Toast error state retains recovery state, suppresses repeated polling errors and reports explicit retries', () => {
  const h = harness(); let [, report] = h.render({suppressRepeated:true});
  report('读取失败'); report('读取失败');
  assert.equal(h.render({suppressRepeated:true})[0], '读取失败'); assert.equal(h.notices.length, 1);
  report(''); report('读取失败');
  assert.equal(h.notices.length, 2); assert.equal(h.notices.at(-1).type, 'error');
  report(''); assert.equal(h.render()[0], ''); assert.equal(h.notices.length, 2);
});

test('External errors notify after render, not on repeated renders or cleared values', () => {
  const h = harness(); h.render('失败', true); assert.equal(h.notices.length, 0); h.flush();
  h.render('失败', true); h.flush(); assert.equal(h.notices.length, 1);
  h.render('', true); h.flush(); assert.equal(h.notices.length, 1);
  h.render('再次失败', true); h.flush(); assert.equal(h.notices.length, 2);
});

test('Repeated explicit validation failures each notify, including after the previous Toast closes', () => {
  const h = harness(); const [, report] = h.render();
  report('请填写名称'); report('请填写名称');
  assert.equal(h.notices.length, 2); assert.equal(h.render()[0], '请填写名称');
});

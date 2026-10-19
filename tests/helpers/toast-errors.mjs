import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/state/useToastError.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
/** Execute the production hook against the component harness, including notification delivery. */
export function loadToastErrorHooks(hooks, notify = () => {}) {
  const react = { ...hooks,
    useRef: hooks.useRef ?? (initial => { const [value] = hooks.useState(() => ({ current: initial })); return value; }),
    useCallback: hooks.useCallback ?? (callback => callback),
  };
  const context = vm.createContext({ exports: {}, require(name) {
    if (name === 'react') return react;
    if (name === './notifications') return { notify };
    throw new Error(name);
  } });
  vm.runInContext(compiled, context);
  return context.exports;
}

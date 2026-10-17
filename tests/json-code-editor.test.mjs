import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const lexer=vm.createContext({exports:{}});vm.runInContext(compile('../src/state/jsonHighlight.ts'),lexer);
const highlight=lexer.exports.highlightJson;
function all(node) { if(Array.isArray(node))return node.flatMap(all);return node?.props?[node,...all(node.props.children)]:[]; }
function harness() {
  const slots=[];let cursor=0;const changed=[];
  const context=vm.createContext({exports:{},require(name){
    if(name==='react')return {useLayoutEffect(){},useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},useMemo(fn){return fn();},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=value;}];}};
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='../state/jsonHighlight')return lexer.exports;
    if(name.endsWith('.css'))return {};
    throw new Error(name);
  }});
  vm.runInContext(compile('../src/components/JsonCodeEditor.tsx'),context);
  return {changed,render(value,extra={}){cursor=0;return context.exports.JsonCodeEditor({id:'json',label:'MCP JSON 配置',value,onChange:value=>changed.push(value),...extra});}};
}
test('JSON lexer recognizes keys, escaped strings, numbers and literals while preserving all original text',()=>{
  const source='{\n "mcpServers": {"text":"汉🙂 \\"quoted\\"", "count":-1.25e+3, "enabled":true,"nothing":null}\n}';
  const tokens=highlight(source);assert.equal(tokens.map(token=>token.text).join(''),source);
  assert.ok(tokens.some(token=>token.type==='key'&&token.text==='"mcpServers"'));
  assert.ok(tokens.some(token=>token.type==='number'&&token.text==='-1.25e+3'));
  assert.ok(tokens.some(token=>token.type==='literal'&&token.text==='true'));
  assert.ok(tokens.some(token=>token.type==='string'&&token.text.includes('汉🙂')));
});
test('Incomplete JSON and untrusted markup remain text and never generate HTML',()=>{
  for(const source of ['{"url":"unfinished','{"name":\n','<script>bad()</script>','"<img src=x onerror=bad()>"','\n\n','']) {
    assert.equal(highlight(source).map(token=>token.text).join(''),source);
    const tree=harness().render(source);
    assert.ok(all(tree).filter(node=>node.type==='span').every(node=>typeof node.props.children==='string'));
    assert.ok(all(tree).every(node=>!node.props.dangerouslySetInnerHTML));
  }
});
test('Native editing supports IME, synchronized scrolling, line numbers and disabled/error state',()=>{
  const h=harness();let tree=h.render('{\n  "enabled": true\n}',{invalid:true,disabled:true});
  const input=all(tree).find(node=>node.type==='textarea');
  assert.equal(input.props.disabled,true);assert.equal(input.props['aria-invalid'],true);
  assert.equal(input.props.autoComplete,'off');
  const pre=all(tree).filter(node=>node.type==='pre');assert.equal(pre[0].props.children,'1\n2\n3');
  pre[0].props.ref.current={style:{},scrollTop:0};pre[1].props.ref.current={style:{},scrollTop:0,scrollLeft:0};
  input.props.onScroll({currentTarget:{clientWidth:600,clientHeight:240,scrollTop:44,scrollLeft:70}});
  assert.equal(pre[0].props.ref.current.scrollTop,44);assert.equal(pre[1].props.ref.current.scrollTop,44);assert.equal(pre[1].props.ref.current.scrollLeft,70);
  input.props.onChange({target:{value:'{"text":"你好"}'}});assert.deepEqual(h.changed,['{"text":"你好"}']);
  input.props.onCompositionStart();tree=h.render('你好');assert.match(tree.props.className,/is-composing/);
  all(tree).find(node=>node.type==='textarea').props.onCompositionEnd();assert.doesNotMatch(h.render('你好').props.className,/is-composing/);
});

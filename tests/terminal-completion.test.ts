import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {testBash} from './helpers/bash.mjs';
import {TerminalCompletionController,safeCompletionSuffix} from '../src/state/terminalCompletion';
import {bashCompletionSetup} from '../src/state/terminalCompletionBash';
import {readCompletionPreferences,saveCompletionPreferences} from '../src/state/terminalCompletionPreferences';
const hex=(value:string)=>Buffer.from(value).toString('hex');
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
async function harness(t:any,request?:(...args:any[])=>Promise<{suffix:string}>,autoReady=true,options:any={}){
  t.mock.timers.enable({apis:['setTimeout']});
  const writes:string[]=[],shown:any[]=[],status:string[]=[],calls:any[]=[];
  let anchor:any={key:'cursor'},resolve:any;
  const controller=new TerminalCompletionController({entries:options.entries,write:async value=>{writes.push(value);},anchor:()=>anchor,
    request:async(...args)=>{calls.push(args);return request?request(...args):new Promise(done=>{resolve=done;});},
    display:value=>shown.push(value),status:value=>status.push(value)});
  controller.configure({enabled:true,aiEnabled:true,sendDirectory:true,modelId:'dedicated-model',delayMs:500,...options.prefs});await controller.initialize();
  const nonce=writes[0].match(/spc;([a-f0-9]{32});R/)![1];
  const osc=(value:string)=>controller.osc(`spc;${nonce};${value}`);
  if(autoReady){osc('R');await flush();osc('I');osc('P;1');}let seq=0;
  const snapshot=(prefix='docker compose',cwd='/opt/app',point=Buffer.byteLength(prefix))=>{
    osc(`S;${++seq};1;${point};${hex(prefix)};${hex(cwd)}`);t.mock.timers.tick(0);
  };
  t.after(()=>controller.dispose());
  return {controller,writes,shown,status,calls,osc,snapshot,setAnchor(value:any){anchor=value;},resolve(value={suffix:' logs -f'}){resolve(value);},
    async type(value='x'){controller.input(value);t.mock.timers.tick(499);assert.equal(calls.length,0);t.mock.timers.tick(1);snapshot();await flush();}};
}

test('设置默认关闭、损坏值回退，选择与延迟持久化且不存密钥',()=>{
  const values=new Map<string,string>(),events:any[]=[];
  Object.assign(globalThis,{localStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)},window:{dispatchEvent:(event:any)=>events.push(event)}});
  assert.deepEqual(readCompletionPreferences(),{enabled:false,aiEnabled:false,sendDirectory:false,modelId:'',delayMs:500});
  saveCompletionPreferences({enabled:true,aiEnabled:true,sendDirectory:false,modelId:'chosen',delayMs:800});assert.deepEqual(readCompletionPreferences(),{enabled:true,aiEnabled:true,sendDirectory:false,modelId:'chosen',delayMs:800});assert.equal(events.length,1);
  values.set([...values.keys()][0],'{bad');assert.equal(readCompletionPreferences().enabled,false);
});

test('停顿后请求真实 Bash 缓冲区，只传当前命令和目录，接受只写后缀而不回车',async t=>{
  const ui=await harness(t);await ui.type();assert.equal(ui.writes.at(-1),'\x1b[99~');
  assert.equal(ui.calls[0][0],'dedicated-model');assert.deepEqual(ui.calls[0][1],{prefix:'docker compose',cwd:'/opt/app'});
  ui.resolve();await flush();assert.equal(ui.shown.at(-1).suffix,' logs -f');
  assert.equal(ui.controller.key({type:'keydown',key:'Tab'} as KeyboardEvent),false);
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),true);
  assert.equal(ui.writes.at(-1),' logs -f');assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),false);
});

test('再次输入取消旧请求，迟到结果不出现；运行、隐藏、断线及配置变化清理建议',async t=>{
  const ui=await harness(t);await ui.type();const signal=ui.calls[0][2];
  ui.controller.input('s');assert.equal(signal.aborted,true);ui.resolve();await flush();assert.equal(ui.shown.at(-1),null);
  ui.osc('B');t.mock.timers.tick(1000);assert.equal(ui.calls.length,1);
  ui.osc('P;2');ui.setAnchor(null);ui.controller.input('x');t.mock.timers.tick(1000);assert.equal(ui.calls.length,1);
  ui.controller.configure({enabled:false,aiEnabled:false,sendDirectory:false,modelId:'other',delayMs:500});assert.equal(ui.shown.at(-1),null);
});

test('切换 sudo 子 Shell 与退出后按各自快照计数接续补全，不接受其他 Shell 的旧快照',async t=>{
  const ui=await harness(t,async()=>({suffix:' --help'}));
  for(const [prompt,sequence,cwd] of [[8,5,'/home/test'],[1,0,'/root'],[9,6,'/home/test']] as const){
    ui.osc('B');ui.osc(`P;${prompt};${sequence}`);
    ui.controller.input('x');t.mock.timers.tick(500);
    const before=ui.calls.length;
    ui.osc(`S;${sequence+2};${prompt};6;${hex('docker')};${hex(cwd)}`);t.mock.timers.tick(0);await flush();
    assert.equal(ui.calls.length,before);
    ui.osc(`S;${sequence+1};${prompt};6;${hex('docker')};${hex(cwd)}`);t.mock.timers.tick(0);await flush();
    assert.equal(ui.calls.length,before+1);
    assert.equal(ui.calls.at(-1)[1].cwd,cwd);
  }
});

test('光标在中间、敏感命令、多行和错误 nonce 不调用模型',async t=>{
  const ui=await harness(t);assert.equal(ui.controller.osc('spc;wrong;P;1'),false);
  for(const [prefix,point] of [['docker compose',2],['curl token=secret',17],['echo\nhello',10]] as const){
    ui.controller.input('x');t.mock.timers.tick(500);ui.snapshot(prefix,'/',point);await flush();
  }
  assert.equal(ui.calls.length,0);
});

test('超时或过期快照不生成建议，集成失联后停止发送探测键',async t=>{
  const ui=await harness(t);ui.controller.input('x');t.mock.timers.tick(500);ui.controller.input('y');ui.snapshot();await flush();assert.equal(ui.calls.length,0);
  t.mock.timers.tick(500);const count=ui.writes.length;t.mock.timers.tick(1201);ui.controller.input('z');t.mock.timers.tick(1000);assert.equal(ui.writes.length,count);assert.match(ui.status.at(-1)!,/失去同步/);
});

test('Esc 仅隐藏建议，输入法和修饰键不接受，位置改变后拒绝旧建议',async t=>{
  const ui=await harness(t,async()=>({suffix:' logs'}));await ui.type();
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight',isComposing:true} as KeyboardEvent),false);
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight',ctrlKey:true} as KeyboardEvent),false);
  assert.equal(ui.controller.key({type:'keydown',key:'Escape'} as KeyboardEvent),true);assert.equal(ui.shown.at(-1),null);
  ui.controller.input('x');t.mock.timers.tick(500);ui.snapshot();await flush();ui.setAnchor({key:'moved'});
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),false);assert.notEqual(ui.writes.at(-1),' logs');
});

test('模型超时取消，模型异常和恶意输出不插入终端',async t=>{
  const ui=await harness(t);await ui.type();t.mock.timers.tick(4000);assert.equal(ui.calls[0][2].aborted,true);ui.resolve();await flush();assert.equal(ui.shown.at(-1),null);
  for(const value of ['', '\nwhoami','x\r','x\x1b[A','```sh','x'.repeat(257)])assert.equal(safeCompletionSuffix(value),false);
  assert.equal(safeCompletionSuffix(' logs --tail 100'),true);
});

test('Bash 集成使用真实内置函数编码并保留提示钩子；重装不重复挂接',()=>{
  const nonce='a'.repeat(32),script=bashCompletionSetup(nonce);
  assert.throws(()=>bashCompletionSetup("x';whoami"));
  const quotedScript="'"+script.replace(/'/g,"'\\''")+"'";
  const command=`PROMPT_COMMAND=':'; PS0='original'; setup=${quotedScript}; eval "$setup"; __spc_prompt; READLINE_LINE='docker compose'; READLINE_POINT=14; __spc_snapshot; eval "$setup"; history -s 'docker logs api'; __spc_begin; [[ $PROMPT_COMMAND == ':; __spc_prompt' ]] || exit 20; [[ $PS0 == '$(__spc_begin)original' ]] || exit 21`;
  const result=spawnSync(testBash(),['--noprofile','--norc','-ic',command],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes(`\x1b]777;spc;${nonce};I\x07`));
  assert.ok(result.stdout.includes(`S;1;1;14;${hex('docker compose')};`));assert.ok(result.stdout.includes(`;H;${hex('docker logs api')}`));
  const array=spawnSync(testBash(),['--noprofile','--norc','-ic',`PROMPT_COMMAND=(:); ${script}; [[ \${#PROMPT_COMMAND[@]} == 2 ]]`],{encoding:'utf8',timeout:10000});
  assert.equal(array.status,0,array.stderr);
});


test('初始化只发送短加载命令，确认静默读取就绪后才发送脚本，重复回执不重发',async t=>{
  const ui=await harness(t,undefined,false);
  assert.equal(ui.writes.length,1);assert.ok(ui.writes[0].length<200);assert.match(ui.writes[0],/read -erst 10/);
  assert.ok(!ui.writes[0].includes('__spc_snapshot'));assert.equal(ui.controller.input('whoami\r'),true);
  await ui.controller.initialize();assert.equal(ui.writes.length,1);
  ui.osc('I');assert.match(ui.status.at(-1)!,/正在初始化/);
  ui.osc('R');await flush();assert.equal(ui.writes.length,2);assert.match(ui.writes[1],/__spc_snapshot/);
  assert.ok(ui.writes[1].endsWith('\r'));ui.osc('R');assert.equal(ui.writes.length,2);
  ui.osc('I');assert.match(ui.status.at(-1)!,/已连接 Bash/);assert.equal(ui.controller.input('x'),false);
});

test('手动接入先绑定原生目录标识，失败或取消时不向 Shell 发送迟到载荷', async () => {
  for (const cancelled of [false, true]) {
    const writes: string[] = []; let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const controller = new TerminalCompletionController({ nonceChanged: () => wait,
      write: async value => { writes.push(value); }, request: async () => ({ suffix: '' }),
      anchor: () => null, display: () => {}, status: () => {} });
    controller.configure({ enabled: true, aiEnabled: false, sendDirectory: false, modelId: '', delayMs: 500 });
    const initialized = controller.initialize();
    assert.equal(writes.length, 0);
    if (cancelled) controller.input('\x03');
    release(); await initialized;
    assert.equal(writes.length, cancelled ? 0 : 1);
    controller.dispose();
  }
});

test('初始化超时、取消与销毁后不发送迟到脚本，允许恢复正常终端输入',async t=>{
  const ui=await harness(t,undefined,false);t.mock.timers.tick(12001);
  ui.osc('R');assert.equal(ui.writes.length,1);assert.match(ui.status.at(-1)!,/未收到 Bash/);
  assert.equal(ui.controller.input('x'),false);
  await ui.controller.initialize();assert.equal(ui.controller.input('\x03'),false);ui.osc('R');assert.equal(ui.writes.length,2);
  await ui.controller.initialize();ui.controller.dispose();ui.osc('R');assert.equal(ui.writes.length,3);
});

test('本地路径候选优先，无模型也可用；目录清单不进入模型请求',async t=>{
  const listed:string[]=[];
  const ui=await harness(t,undefined,true,{prefs:{aiEnabled:false,modelId:''},entries:async(path:string)=>{listed.push(path);return [{name:'compose.yaml',directory:false},{name:'config.json',directory:false}];}});
  ui.controller.input('o');t.mock.timers.tick(500);ui.snapshot('cat ./comp','/opt/shop');await flush();
  assert.deepEqual(listed,['/opt/shop']);assert.equal(ui.shown.at(-1).suffix,'ose.yaml');assert.equal(ui.calls.length,0);
  ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent);assert.equal(ui.writes.at(-1),'ose.yaml');
});

test('路径查询失败或无匹配不会上传路径上下文给 AI；AI 默认省略当前目录',async t=>{
  const ui=await harness(t,async()=>({suffix:'ormat'}),true,{prefs:{sendDirectory:false},entries:async()=>{throw new Error('denied');}});
  ui.controller.input('x');t.mock.timers.tick(500);ui.snapshot('cat ./private','/secret');await flush();assert.equal(ui.calls.length,0);
  ui.controller.input('x');t.mock.timers.tick(500);ui.snapshot('docker ps --f','/secret');await flush();
  assert.deepEqual(ui.calls[0][1],{prefix:'docker ps --f',cwd:''});assert.equal(ui.shown.at(-1).suffix,'ormat');
});

test('仅记录本次手动执行历史，AI 执行回执和敏感命令不进入候选；历史不发送给模型',async t=>{
  const ui=await harness(t,undefined,true,{prefs:{aiEnabled:false}});
  ui.osc('H;'+hex('docker system prune')); // No manual Enter: ignore Agent execution.
  ui.controller.input('\r');ui.osc('B');ui.osc('H;'+hex('docker logs api'));ui.osc('P;1');
  ui.controller.input('\r');ui.osc('B');ui.osc('H;'+hex('curl token=private'));ui.osc('P;1');
  ui.controller.input('x');t.mock.timers.tick(500);ui.snapshot('docker lo');await flush();assert.equal(ui.shown.at(-1).suffix,'gs api');assert.equal(ui.calls.length,0);
  ui.controller.input('x');t.mock.timers.tick(500);ui.snapshot('docker system');await flush();assert.equal(ui.shown.at(-1),null);
});

test('继续输入匹配灰字时保留剩余建议，等待真实回显后重定位，不重复请求',async t=>{
  const ui=await harness(t,async()=>({suffix:' logs -f'}));await ui.type();
  const before=ui.shown.length;ui.controller.input(' ');assert.equal(ui.shown.length,before);
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),false);
  ui.setAnchor({key:'after-echo'});ui.controller.rendered();assert.equal(ui.shown.at(-1).suffix,'logs -f');
  t.mock.timers.tick(1000);assert.equal(ui.calls.length,1);
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),true);assert.equal(ui.writes.at(-1),'logs -f');
});

test('采用新连接已安装的 nonce，无需再注入脚本；关闭时不请求',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const writes:string[]=[],calls:any[]=[];
  const controller=new TerminalCompletionController({write:async v=>{writes.push(v);},request:async(...args)=>{calls.push(args);return {suffix:' x'};},anchor:()=>({key:'a'}),display(){},status(){}});
  controller.configure({enabled:false,aiEnabled:false,sendDirectory:false,modelId:'',delayMs:500});controller.adopt('a'.repeat(32));
  controller.osc('spc;'+'a'.repeat(32)+';P;1');controller.input('docker');t.mock.timers.tick(1000);
  assert.equal(writes.length,0);assert.equal(calls.length,0);controller.dispose();
});

test('自动接入只更新补全状态，用户手动初始化仍提供成功反馈', async () => {
  const writes: string[] = [], statuses: { text: string; announce?: boolean }[] = [];
  const controller = new TerminalCompletionController({ write: async value => { writes.push(value); },
    request: async () => ({ suffix: '' }), anchor: () => null, display: () => {},
    status: (text, announce) => { statuses.push({ text, announce }); } });
  controller.adopt('a'.repeat(32));
  assert.equal(statuses.at(-1)?.announce, false);
  controller.configure({ enabled: true, aiEnabled: false, sendDirectory: false, modelId: '', delayMs: 500 });
  await controller.initialize();
  const nonce = writes[0].match(/spc;([a-f0-9]{32});R/)![1];
  controller.osc(`spc;${nonce};R`); await flush(); controller.osc(`spc;${nonce};I`);
  assert.match(statuses.at(-1)!.text, /已连接 Bash/);
  assert.notEqual(statuses.at(-1)?.announce, false);
  controller.dispose();
});


test('接受路径或远端 Tab 补齐后的尾随空格不重复文件，也不请求 AI 兜底',async t=>{
  let listed=0;
  const ui=await harness(t,async()=>({suffix:'get-docker.sh'}),true,{entries:async()=>{listed++;return [{name:'get-docker.sh',directory:false}];}});
  ui.controller.input('get-');t.mock.timers.tick(500);ui.snapshot('cat get-','/root');await flush();
  assert.equal(ui.shown.at(-1).suffix,'docker.sh');
  assert.equal(ui.controller.key({type:'keydown',key:'ArrowRight'} as KeyboardEvent),true);
  assert.equal(ui.writes.at(-1),'docker.sh');
  ui.controller.input(' ');t.mock.timers.tick(500);ui.snapshot('cat get-docker.sh ','/root');await flush();
  assert.equal(ui.shown.at(-1),null);
  ui.controller.input('\t');t.mock.timers.tick(500);ui.snapshot('cat get-docker.sh ','/root');await flush();
  assert.equal(ui.shown.at(-1),null);assert.equal(listed,1);assert.equal(ui.calls.length,0);
});

import type { CompletionPreferences } from './terminalCompletionPreferences';
import { bashCompletionSetup, bashCompletionBootstrap } from './terminalCompletionBash';
import { historySuffix, pathQuery, pathSuffix, sensitiveCommand } from './terminalCompletionLocal';
import type { CompletionEntry } from './terminalCompletionLocal';
export type CompletionAnchor = {key:string};
export type InlineSuggestion = {suffix:string;anchor:CompletionAnchor};
type Bridge = {
  write:(input:string)=>Promise<void>;
  request:(modelId:string,context:{prefix:string;cwd:string},signal:AbortSignal)=>Promise<{suffix:string}>;
  entries?:(path:string,signal:AbortSignal)=>Promise<CompletionEntry[]>;
  captureState?:(active:boolean)=>void;
  nonceChanged?:(nonce:string)=>void|Promise<void>;
  line?:()=>string;
  anchor:()=>CompletionAnchor|null;
  display:(value:InlineSuggestion|null)=>void;
  status:(text:string,announce?:boolean)=>void;
};
const SNAPSHOT_KEY='\x1b[99~';
export function safeCompletionSuffix(value:unknown):value is string {
  return typeof value==='string' && value.length>0 && new TextEncoder().encode(value).length<=256
    && !/[\x00-\x1f\x7f-\x9f]/u.test(value) && !value.includes('```') && !!value.trim();
}
function decodeHex(value:string,max:number):string|null {
  if(value.length>max*2 || value.length%2 || !/^[a-f\d]*$/i.test(value))return null;
  try{return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(value.match(/../g)??[],hex=>parseInt(hex,16)));}catch{return null;}
}
export class TerminalCompletionController {
  private prefs:CompletionPreferences={enabled:false,aiEnabled:false,sendDirectory:false,modelId:'',delayMs:500};
  private initializing:'reading'|'installing'|null=null;
  private nonce='';private ready=false;private prompt=0;private seq=0;private revision=0;private disposed=false;
  private timer:ReturnType<typeof setTimeout>|undefined;private deadline:ReturnType<typeof setTimeout>|undefined;
  private pending:{seq:number;revision:number}|null=null;
  private request:AbortController|null=null;private suggestion:InlineSuggestion|null=null;
  private suggestionPrefix='';private retained:{prefix:string;suffix:string;anchor:CompletionAnchor}|null=null;
  private manualCommand=false;private history:string[]=[];
  private directories=new Map<string,{time:number;entries:CompletionEntry[]}>();
  constructor(private bridge:Bridge){}
  configure(prefs:CompletionPreferences){this.prefs=prefs;this.invalidate();}
  adopt(nonce:string){
    if(!/^[a-f0-9]{32}$/.test(nonce)||this.disposed)return;
    this.nonce=nonce;this.ready=true;this.prompt=0;this.seq=0;this.bridge.status('已连接 Bash · → 接受 · Esc 隐藏',false);
  }
  private invalidate(preserve=false){
    this.revision++;clearTimeout(this.timer);this.request?.abort();this.request=null;this.suggestion=null;
    if(!preserve){this.retained=null;this.bridge.display(null);}
  }
  suspend(){this.invalidate();this.bridge.captureState?.(false);}
  private enabled(){return !this.disposed&&this.prefs.enabled&&!!this.bridge.anchor();}
  async initialize(){
    if(this.disposed||this.initializing||!this.prefs.enabled)return;
    this.invalidate();this.ready=false;this.prompt=0;this.seq=0;this.pending=null;clearTimeout(this.deadline);
    this.initializing='reading';this.nonce=crypto.randomUUID().replace(/-/g,'');this.bridge.status('正在初始化…');
    const nonce=this.nonce;
    this.deadline=setTimeout(()=>{this.initializing=null;this.ready=false;this.bridge.status('未收到 Bash 确认，请回到空提示符后重试');},12000);
    try{
      await this.bridge.nonceChanged?.(nonce);
      if(this.disposed||this.initializing!=='reading'||this.nonce!==nonce)return;
      await this.bridge.write(bashCompletionBootstrap(nonce)+'\r');
    }
    catch{if(this.nonce!==nonce)return;this.initializing=null;clearTimeout(this.deadline);this.bridge.status('初始化失败，请检查连接');}
  }
  /** Returns true only while initialization is consuming its private payload. */
  input(data:string){
    if(this.initializing){
      if(!data.includes('\x03'))return true;
      this.initializing=null;clearTimeout(this.deadline);this.bridge.status('初始化已取消，请回到空提示符后重试');
    }
    const current=this.retained??(this.suggestion?{prefix:this.suggestionPrefix,suffix:this.suggestion.suffix,anchor:this.suggestion.anchor}:null);
    if(current && !/[\x00-\x1f\x7f]/u.test(data) && current.suffix.startsWith(data) && current.suffix.length>data.length){
      this.retained={prefix:current.prefix+data,suffix:current.suffix.slice(data.length),anchor:current.anchor};this.invalidate(true);return false;
    }
    this.invalidate();
    if(/[\r\n]/.test(data)){this.manualCommand=this.prefs.enabled;this.ready=false;this.prompt=0;return false;}
    if(/[\x03\x04]/.test(data)){this.manualCommand=false;this.ready=false;this.prompt=0;return false;}
    this.schedule();return false;
  }
  /** After parsing echo, retain a matching suggestion instead of hiding and requesting it again. */
  rendered(){
    const retained=this.retained,anchor=this.bridge.anchor();
    if(retained){
      if(!anchor || (this.bridge.line && !this.bridge.line().endsWith(retained.prefix))){this.invalidate();this.schedule();return;}
      if(anchor.key===retained.anchor.key)return;
      this.retained=null;this.suggestionPrefix=retained.prefix;this.suggestion={suffix:retained.suffix,anchor};this.bridge.display(this.suggestion);return;
    }
    if(this.suggestion&&anchor?.key!==this.suggestion.anchor.key)this.invalidate();
  }
  private schedule(){
    clearTimeout(this.timer);
    if(this.enabled()&&this.ready&&this.prompt)this.timer=setTimeout(()=>void this.capture(),this.prefs.delayMs);
  }
  private async capture(){
    if(!this.enabled()||!this.ready||!this.prompt||this.pending)return;
    const pending={seq:++this.seq,revision:this.revision};this.pending=pending;this.bridge.captureState?.(true);
    clearTimeout(this.deadline);
    this.deadline=setTimeout(()=>{if(this.pending===pending){this.pending=null;this.ready=false;this.bridge.captureState?.(false);this.bridge.status('Shell 集成已失去同步，请重新连接或重试');}},1200);
    try{await this.bridge.write(SNAPSHOT_KEY);}catch{this.ready=false;this.pending=null;clearTimeout(this.deadline);this.bridge.captureState?.(false);this.bridge.status('终端输入暂不可用');}
  }
  osc(data:string):boolean {
    if(this.disposed||!this.nonce||!data.startsWith(`spc;${this.nonce};`))return false;
    const parts=data.split(';').slice(2),kind=parts[0];
    if(kind==='R'){
      if(this.initializing!=='reading')return true;
      this.initializing='installing';
      void this.bridge.write(bashCompletionSetup(this.nonce)+'\r').catch(()=>{this.initializing=null;this.ready=false;clearTimeout(this.deadline);this.bridge.status('初始化失败，请检查连接');});return true;
    }
    if(kind==='I'){
      if(this.initializing!=='installing')return true;
      this.initializing=null;clearTimeout(this.deadline);this.ready=true;this.bridge.status('已连接 Bash · → 接受 · Esc 隐藏');return true;
    }
    if(kind==='U'){this.initializing=null;this.ready=false;clearTimeout(this.deadline);this.bridge.status('当前 Shell 不支持补全，需要 Bash 4.4+ emacs 模式');return true;}
    if(kind==='H'){
      if(this.manualCommand&&this.prefs.enabled){
        const command=decodeHex(parts[1]??'',512);
        if(command&&command.trim().length>=2&&!/[\x00-\x1f\x7f]/u.test(command)&&!sensitiveCommand(command)&&!command.includes('__spc_')&&!command.includes('ShellPilot')){
          this.history=this.history.filter(value=>value!==command);this.history.push(command);if(this.history.length>100)this.history.shift();
        }
      }
      this.manualCommand=false;return true;
    }
    if(kind==='B'){this.invalidate();this.ready=false;this.prompt=0;this.pending=null;clearTimeout(this.deadline);this.bridge.captureState?.(false);return true;}
    if(kind==='P'){
      this.invalidate();this.manualCommand=false;this.prompt=Number(parts[1])||0;
      // A nested sudo shell has its own snapshot counter; exiting restores the
      // parent's counter. Older integrations omit this optional field.
      const sequence=Number(parts[2]);
      if(parts[2]!==undefined&&Number.isSafeInteger(sequence)&&sequence>=0)this.seq=sequence;
      this.ready=true;this.pending=null;clearTimeout(this.deadline);this.bridge.captureState?.(false);return true;
    }
    if(kind!=='S')return true;
    const pending=this.pending;if(!pending||Number(parts[1])!==pending.seq)return true;
    this.pending=null;clearTimeout(this.deadline);this.bridge.captureState?.(false);
    if(pending.revision!==this.revision){this.schedule();return true;}
    if(!this.ready||Number(parts[2])!==this.prompt||!this.enabled())return true;
    const prefix=decodeHex(parts[4]??'',512),cwd=decodeHex(parts[5]??'',1024),home=decodeHex(parts[6]??'',1024)??'';
    if(prefix===null||cwd===null||Number(parts[3])!==new TextEncoder().encode(prefix).length||prefix.trim().length<2
      ||/[\x00-\x1f\x7f-\x9f]/u.test(prefix+cwd+home)||sensitiveCommand(prefix))return true;
    this.timer=setTimeout(()=>void this.complete(prefix,cwd,home,pending.revision),0);return true;
  }
  private async complete(prefix:string,cwd:string,home:string,revision:number){
    const anchor=this.bridge.anchor();if(!anchor||revision!==this.revision||!this.enabled())return;
    const controller=new AbortController();this.request=controller;
    const deadline=setTimeout(()=>controller.abort(),4000);
    const valid=()=>!controller.signal.aborted&&!this.disposed&&revision===this.revision&&this.enabled()&&this.bridge.anchor()?.key===anchor.key;
    const show=(suffix:string,source:string)=>{if(valid()&&safeCompletionSuffix(suffix)){this.suggestionPrefix=prefix;this.suggestion={suffix,anchor};this.bridge.display(this.suggestion);this.bridge.status(`${source} · → 接受 · Esc 隐藏`);return true;}return false;};
    try{
      const history=historySuffix(prefix,this.history);if(history&&show(history,'本次终端历史'))return;
      const query=pathQuery(prefix,cwd,home);
      if(query){
        let suffix='';
        if(this.bridge.entries){
          const cached=this.directories.get(query.path);
          try{
            const entries=cached&&Date.now()-cached.time<3000?cached.entries:await this.bridge.entries(query.path,controller.signal);
            if(!valid())return;
            this.directories.delete(query.path);this.directories.set(query.path,{time:Date.now(),entries});if(this.directories.size>8)this.directories.delete(this.directories.keys().next().value!);
            suffix=pathSuffix(query,entries);
          }catch{if(query.exclusive)return;}
        }
        if(suffix&&show(suffix,'路径补全'))return;
        if(query.exclusive)return;
      }
      if(!valid()||!this.prefs.aiEnabled||!this.prefs.modelId)return;
      const result=await this.bridge.request(this.prefs.modelId,{prefix,cwd:this.prefs.sendDirectory?cwd:''},controller.signal);
      show(result.suffix,'AI 续写');
    }catch{if(!controller.signal.aborted&&revision===this.revision)this.bridge.status('补全暂不可用，可继续输入后重试');}
    finally{clearTimeout(deadline);if(this.request===controller)this.request=null;}
  }
  key(event:KeyboardEvent):boolean {
    if(event.type!=='keydown'||event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||(!this.suggestion&&!this.retained)||!this.enabled())return false;
    if(event.key==='Escape'){this.invalidate();return true;}
    if(event.key!=='ArrowRight'||!this.suggestion||this.retained)return false;
    const suggestion=this.suggestion;if(this.bridge.anchor()?.key!==suggestion.anchor.key){this.invalidate();return false;}
    this.invalidate();void this.bridge.write(suggestion.suffix).catch(()=>this.bridge.status('补全填入失败，请检查连接'));return true;
  }
  dispose(){this.disposed=true;this.initializing=null;this.invalidate();this.pending=null;this.history=[];this.directories.clear();clearTimeout(this.deadline);this.bridge.captureState?.(false);}
}

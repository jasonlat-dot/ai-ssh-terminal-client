import type { Terminal } from '@xterm/xterm';
import { requestTerminalCompletion } from '../api/terminalCompletion';
import type { CompletionEntry } from './terminalCompletionLocal';
import { TerminalCompletionController } from './terminalCompletion';
import { COMPLETION_SETTINGS_EVENT, readCompletionPreferences } from './terminalCompletionPreferences';
/** Uses public xterm APIs; ghost text never enters its buffer, selection or SSH output. */
export function attachTerminalCompletion(terminal:Terminal,write:(input:string)=>Promise<void>,eligible:()=>boolean,status:(text:string,announce?:boolean)=>void,request=requestTerminalCompletion,options:{nonce?:string;nonceChanged?:(nonce:string)=>void|Promise<void>;entries?:(path:string,signal:AbortSignal)=>Promise<CompletionEntry[]>}={}){
  let composing=false,buffering=false,finishing=false,disposed=false;
  let releaseTimer:ReturnType<typeof setTimeout>|undefined,limitTimer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{clearTimeout(releaseTimer);clearTimeout(limitTimer);finishing=false;if(buffering){buffering=false;terminal.write('\x1b[?2026l');}};
  const finish=()=>{if(!buffering)return;finishing=true;clearTimeout(releaseTimer);releaseTimer=setTimeout(release,50);};
  const captureState=(active:boolean)=>{
    if(disposed)return;
    if(active){clearTimeout(releaseTimer);clearTimeout(limitTimer);finishing=false;if(!buffering){buffering=true;terminal.write('\x1b[?2026h');}limitTimer=setTimeout(release,1300);}
    else finish();
  };
  const ghost=document.createElement('span');ghost.className='terminal-completion-ghost';ghost.setAttribute('aria-hidden','true');ghost.hidden=true;document.body.appendChild(ghost);
  const position=()=>{
    const buffer=terminal.buffer.active,screen=terminal.element?.querySelector('.xterm-screen');
    if(!eligible()||!document.hasFocus()||document.visibilityState==='hidden'||composing||buffer.type!=='normal'||buffer.viewportY!==buffer.baseY||terminal.hasSelection()||!screen
      || !terminal.element?.contains(document.activeElement)||buffer.cursorX>=terminal.cols-1||buffer.getLine(buffer.baseY+buffer.cursorY)?.isWrapped)return null;
    const box=screen.getBoundingClientRect(),width=box.width/terminal.cols,height=box.height/terminal.rows;
    if(!width||!height)return null;
    return {key:[buffer.baseY,buffer.cursorX,buffer.cursorY,terminal.cols,terminal.rows,box.left,box.top,box.width,box.height].join(':'),
      left:box.left+buffer.cursorX*width,top:box.top+buffer.cursorY*height,width:box.width-buffer.cursorX*width,height};
  };
  const controller=new TerminalCompletionController({write,request,entries:options.entries,nonceChanged:options.nonceChanged,captureState,anchor:position,status,
    line:()=>{const buffer=terminal.buffer.active;return buffer.getLine(buffer.baseY+buffer.cursorY)?.translateToString(true,0,buffer.cursorX)??'';},
    display(value){
      const box=position();
      if(!value||!box||box.key!==value.anchor.key){ghost.hidden=true;ghost.textContent='';return;}
      ghost.textContent=value.suffix;
      Object.assign(ghost.style,{left:`${box.left}px`,top:`${box.top}px`,maxWidth:`${box.width}px`,lineHeight:`${box.height}px`,
        height:`${box.height}px`,fontFamily:terminal.options.fontFamily,fontSize:`${terminal.options.fontSize}px`,fontWeight:String(terminal.options.fontWeight??400),letterSpacing:`${terminal.options.letterSpacing??0}px`});
      ghost.hidden=false;
    }});
  const configure=()=>controller.configure(readCompletionPreferences());configure();if(options.nonce)controller.adopt(options.nonce);
  const suspend=()=>{controller.suspend();release();};
  const start=()=>{composing=true;suspend();},end=()=>{composing=false;};
  terminal.element?.addEventListener('compositionstart',start,true);terminal.element?.addEventListener('compositionend',end,true);
  terminal.element?.addEventListener('focusout',suspend);
  const listeners=[terminal.parser.registerOscHandler(777,data=>controller.osc(data)),terminal.onScroll(suspend),terminal.onResize(suspend),terminal.onSelectionChange(suspend),
    terminal.onWriteParsed(()=>{if(finishing)finish();controller.rendered();})];
  window.addEventListener(COMPLETION_SETTINGS_EVENT,configure);window.addEventListener('blur',suspend);window.addEventListener('resize',suspend);window.addEventListener('scroll',suspend,true);
  return {controller,suspend,dispose(){controller.dispose();release();disposed=true;listeners.forEach(listener=>listener.dispose());ghost.remove();
    terminal.element?.removeEventListener('compositionstart',start,true);terminal.element?.removeEventListener('compositionend',end,true);terminal.element?.removeEventListener('focusout',suspend);
    window.removeEventListener(COMPLETION_SETTINGS_EVENT,configure);window.removeEventListener('blur',suspend);window.removeEventListener('resize',suspend);window.removeEventListener('scroll',suspend,true);}};
}

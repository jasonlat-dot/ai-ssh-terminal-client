import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {CSSProperties,KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import type {AgentConfig} from '../api/agent';
import {groupModels} from '../state/modelChannels';
import {modelPickerPosition} from '../state/modelPickerPosition';
import {modelProtocols} from '../api/modelProtocols';
import {ModelSupplierIcon} from './ModelSupplierIcon';
import {Icon} from './Ui';
import './Select.css';
import './ModelPicker.css';

/** Two-level channel/model chooser; values remain the native model profile IDs. */
export function ModelPicker({models,value,disabled,onChange}:{models:AgentConfig[];value:string;disabled:boolean;onChange:(id:string)=>void}) {
  const groups=groupModels(models);
  const selected=models.find(model=>model.agentId===value);
  const trigger=useRef<HTMLButtonElement>(null);
  const menu=useRef<HTMLDivElement>(null);
  const focusPending=useRef(false);
  const id=useId();
  const [open,setOpen]=useState(false);
  const [groupId,setGroupId]=useState('');
  const [index,setIndex]=useState(0);
  const [level,setLevel]=useState<'group'|'model'>('model');
  const [position,setPosition]=useState<(CSSProperties&{compact:boolean})|null>(null);
  const group=groups.find(item=>item.id===groupId)??groups[0];
  const groupIndex=Math.max(0,groups.findIndex(item=>item.id===group?.id));
  const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();};
  const show=(keyboard=false)=>{
    if(disabled||!groups.length)return;
    const current=groups.find(item=>item.models.some(model=>model.agentId===value))??groups[0];
    setGroupId(current.id);setIndex(Math.max(0,current.models.findIndex(model=>model.agentId===value)));
    setLevel('model');focusPending.current=keyboard;setOpen(true);
  };
  const chooseGroup=(id:string,keyboard=false)=>{
    const next=groups.find(item=>item.id===id);if(!next)return;
    setGroupId(id);setIndex(Math.max(0,next.models.findIndex(model=>model.agentId===value)));setLevel('model');focusPending.current=keyboard;
  };
  const choose=(model:AgentConfig)=>{if(disabled)return;onChange(model.agentId);close(true);};
  useEffect(()=>{if(disabled||!models.length)setOpen(false);},[disabled,models.length]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!trigger.current?.contains(event.target as Node)&&!menu.current?.contains(event.target as Node))close();};
    const blur=()=>close();
    document.addEventListener('pointerdown',outside);window.addEventListener('blur',blur);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('blur',blur);};
  },[open]);
  useLayoutEffect(()=>{
    if(!open){setPosition(null);return;}
    const place=()=>{
      const rect=trigger.current?.getBoundingClientRect();if(!rect)return;
      setPosition(modelPickerPosition({trigger:rect,panel:trigger.current?.closest('.agent-panel')?.getBoundingClientRect(),
        composer:trigger.current?.closest('.chat-composer')?.getBoundingClientRect(),viewport:{width:window.innerWidth,height:window.innerHeight},
        groupRows:groups.length,modelRows:group?.models.length??0,level}));
    };
    const scroll=(event:Event)=>{if(!menu.current?.contains(event.target as Node))place();};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',scroll,true);
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(place):null;
    const panel=trigger.current?.closest('.agent-panel'),composer=trigger.current?.closest('.chat-composer');
    if(panel)observer?.observe(panel);if(composer)observer?.observe(composer);
    return()=>{observer?.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',scroll,true);};
  },[open,groups.length,group?.id,group?.models.length,level]);
  useLayoutEffect(()=>{
    if(!open||!position||!focusPending.current)return;
    focusPending.current=false;
    const button=menu.current?.querySelector<HTMLButtonElement>(level==='group'?`[data-group-index="${groupIndex}"]`:`[data-model-index="${index}"]`);
    button?.focus();button?.scrollIntoView({block:'nearest'});
  },[open,!!position,level,groupIndex,index]);
  const onKeyDown=(event:KeyboardEvent)=>{
    if(disabled||!groups.length)return;
    if(event.key==='Tab'){close();return;}
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close(true);return;}
    if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(!open){show(true);return;}
    focusPending.current=true;
    if(event.key==='ArrowLeft'){setLevel('group');return;}
    if(event.key==='ArrowRight'){setLevel('model');return;}
    if(event.key==='Enter'||event.key===' '){if(level==='group'&&group)chooseGroup(group.id,true);else if(group?.models[index])choose(group.models[index]);return;}
    const length=level==='group'?groups.length:group?.models.length??0;
    const current=level==='group'?groupIndex:index;
    const next=event.key==='Home'?0:event.key==='End'?length-1:(current+(event.key==='ArrowUp'?-1:1)+length)%length;
    if(level==='group'){const nextGroup=groups[next];if(nextGroup){setGroupId(nextGroup.id);setIndex(Math.max(0,nextGroup.models.findIndex(model=>model.agentId===value)));}}
    else setIndex(next);
  };
  const {compact,...style}=position??{compact:false};
  return <>
    <button ref={trigger} type="button" className="ui-select-trigger model-picker-trigger" aria-label="对话模型" aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled||!models.length} onClick={()=>open?close():show()} onKeyDown={onKeyDown}>
      <span className="ui-select-label-with-icon" title={selected?`${selected.agentName} · ${selected.modelName??selected.agentId}`:undefined}>{selected&&<span className="model-channel-avatar" aria-hidden="true">{selected.provider?<ModelSupplierIcon supplier={modelProtocols[selected.provider].supplier} size={18}/>:<Icon name="network" size={18}/>}</span>}<span>{selected?(selected.modelName??selected.agentId):models.length?'请选择模型':'请先添加模型'}</span></span><Icon name="down" size={15}/>
    </button>
    {open&&group&&createPortal(<div ref={menu} id={id} className={`model-picker-menu${compact?' is-compact':''}`} style={position?style:{visibility:'hidden'}} onKeyDown={onKeyDown}>
      {(!compact||level==='group')&&<div className="model-picker-panel model-picker-groups" role="menu" aria-label="供应商渠道">
        <div className="model-picker-heading">供应商<span>{groups.length} 个渠道</span></div>
        <div className="model-picker-list">{groups.map((item,i)=><button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={item.id===group.id} tabIndex={-1} data-group-index={i} key={item.id} className={item.id===group.id?'is-active':''}
          onPointerMove={()=>{if(!compact&&item.id!==group.id)chooseGroup(item.id);}} onFocus={()=>{if(item.id!==group.id){setGroupId(item.id);setIndex(0);}setLevel('group');}}
          onClick={()=>chooseGroup(item.id,true)}><span className="model-channel-avatar" aria-hidden="true">{item.provider?<ModelSupplierIcon supplier={modelProtocols[item.provider].supplier} size={18}/>:<Icon name="network" size={18}/>}</span><span className="model-picker-label" title={item.label}>{item.label}</span><small>{item.models.length}</small><Icon name="right" size={13}/></button>)}</div>
      </div>}
      {(!compact||level==='model')&&<div className="model-picker-panel model-picker-models" role="menu" aria-label={`${group.label}的模型`}>
        <div className="model-picker-heading">{compact&&<button type="button" aria-label="返回供应商" onClick={()=>{focusPending.current=true;setLevel('group');}}><Icon name="left" size={14}/></button>}<span className="model-picker-label">{group.label}</span></div>
        <div className="model-picker-list">{group.models.map((model,i)=><button type="button" role="menuitemradio" aria-checked={model.agentId===value} tabIndex={-1} data-model-index={i} key={model.agentId} className={`${model.agentId===value?'is-selected ':''}${level==='model'&&index===i?'is-active':''}`}
          onPointerMove={()=>{setLevel('model');setIndex(i);}} onFocus={()=>{setLevel('model');setIndex(i);}} onClick={()=>choose(model)}><span className="model-channel-avatar" aria-hidden="true">{model.provider?<ModelSupplierIcon supplier={modelProtocols[model.provider].supplier} size={18}/>:<Icon name="network" size={18}/>}</span><span className="model-picker-label" title={model.modelName??model.agentId}>{model.modelName??model.agentId}</span>{model.agentId===value&&<Icon name="check" size={14}/>}</button>)}</div>
      </div>}
    </div>,document.body)}
  </>;
}

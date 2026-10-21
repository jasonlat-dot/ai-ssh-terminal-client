import { useEffect, useState } from 'react';
import { modelApi } from '../api/models';
import type { ModelProfile } from '../api/models';
import { readCompletionPreferences, saveCompletionPreferences } from '../state/terminalCompletionPreferences';
import { notify } from '../state/notifications';
import { Select } from './Select';
import { Toggle, Icon } from './Ui';
import './TerminalCompletion.css';
export function TerminalCompletionSettings(){
  const [prefs,setPrefs]=useState(readCompletionPreferences);
  const [models,setModels]=useState<ModelProfile[]>([]);
  const [loading,setLoading]=useState(true);
  const [failed,setFailed]=useState(false);
  const load=()=>{setLoading(true);setFailed(false);return modelApi.list().then(setModels).catch(()=>setFailed(true)).finally(()=>setLoading(false));};
  useEffect(()=>{let active=true;void modelApi.list().then(value=>{if(active)setModels(value);}).catch(()=>{if(active)setFailed(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const change=(next:typeof prefs)=>{try{saveCompletionPreferences(next);setPrefs(next);}catch{notify('补全设置保存失败，请重试。','error');}};
  const options=[{value:'',label:'请选择补全模型'},...models.filter(model=>model.ready).map(model=>({value:model.id,label:`${model.displayName??model.id} · ${model.config.model}`}))];
  if(prefs.modelId&&!options.some(item=>item.value===prefs.modelId))options.push({value:prefs.modelId,label:'原补全模型暂不可用，请重新选择'});
  return <section className="terminal-completion-settings" aria-label="终端智能补全">
    <header><strong><Icon name="bot" size={16}/>终端智能补全</strong><div className="terminal-completion-setting-actions"><button type="button" className="outlined-button" disabled={loading} onClick={()=>void load()}>刷新模型</button><Toggle label="启用终端智能补全" value={prefs.enabled} onChange={enabled=>change({...prefs,enabled})}/></div></header>
    <div className="terminal-completion-fields"><label>AI 续写模型<Select label="补全模型" value={prefs.modelId} options={options} disabled={loading||!prefs.aiEnabled} onChange={modelId=>change({...prefs,modelId})}/></label>
      <label>停止输入后触发<Select label="补全触发延迟" value={prefs.delayMs} options={[300,500,800,1000].map(value=>({value,label:`${value} ms`}))} onChange={delayMs=>change({...prefs,delayMs})}/></label></div>
    <div className="terminal-completion-privacy"><Toggle label="AI 续写" value={prefs.aiEnabled} onChange={aiEnabled=>change({...prefs,aiEnabled})}/><Toggle label="向 AI 提供当前目录" value={prefs.sendDirectory} disabled={!prefs.aiEnabled} onChange={sendDirectory=>change({...prefs,sendDirectory})}/></div>
    <p>开启后，新建或重连 SSH 会话自动接入 Bash 4.4+ emacs 模式。路径与本次终端手动命令历史优先在应用内匹配，不读取文件正文，不上传候选列表或历史。AI 续写独立开启，仅发送当前输入；目录默认不发送。Tab 保留远端补全，接受建议后仍需手动回车。</p>
    {failed&&<button type="button" className="outlined-button" disabled={loading} onClick={()=>void load()}>重新读取模型</button>}
  </section>;
}

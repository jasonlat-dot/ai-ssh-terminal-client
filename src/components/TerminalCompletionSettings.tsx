import { useEffect, useState } from 'react';
import { agentApi } from '../api/agent';
import type { AgentConfig } from '../api/agent';
import { readCompletionPreferences, saveCompletionPreferences } from '../state/terminalCompletionPreferences';
import { notify } from '../state/notifications';
import { Select } from './Select';
import { ModelPicker } from './ModelPicker';
import { Toggle, Icon } from './Ui';
import './TerminalCompletion.css';
export function TerminalCompletionSettings(){
  const [prefs,setPrefs]=useState(readCompletionPreferences);
  const [models,setModels]=useState<AgentConfig[]>([]);
  const [loading,setLoading]=useState(true);
  const [failed,setFailed]=useState(false);
  const load=()=>{setLoading(true);setFailed(false);return agentApi.list().then(setModels).catch(()=>setFailed(true)).finally(()=>setLoading(false));};
  useEffect(()=>{let active=true;void agentApi.list().then(value=>{if(active)setModels(value);}).catch(()=>{if(active)setFailed(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const change=(next:typeof prefs)=>{try{saveCompletionPreferences(next);setPrefs(next);}catch{notify('补全设置保存失败，请重试。','error');}};
  const modelReady=models.some(model=>model.agentId===prefs.modelId);
  const stateText=!prefs.enabled?'补全总开关已关闭，AI 续写和目录选项不会生效。'
    :!prefs.aiEnabled?'已开启路径和本次终端历史补全；AI 续写未开启。'
    :loading?'补全已开启，正在读取 AI 模型配置…'
    :failed?'路径和历史补全已开启；AI 模型读取失败，请刷新模型。'
    :!modelReady?'路径和历史补全已开启；AI 续写需要先选择一个可用模型。'
    :'已开启路径、历史和 AI 续写。首次使用请按下方说明接入 SSH 终端。';
  return <section className="terminal-completion-settings" aria-label="终端智能补全">
    <header><strong><Icon name="bot" size={16}/>终端智能补全</strong><div className="terminal-completion-setting-actions"><button type="button" className="outlined-button" disabled={loading} onClick={()=>void load()}>刷新模型</button><span className="terminal-completion-master-label">启用补全<Toggle label="启用终端智能补全" value={prefs.enabled} onChange={enabled=>change({...prefs,enabled})}/></span></div></header>
    <p className="terminal-completion-state" role="status">{stateText}</p>
    <div className="terminal-completion-fields"><label>AI 续写模型<ModelPicker label="补全模型" value={prefs.modelId} models={models} placeholder={prefs.modelId&&!modelReady&&!loading&&!failed?'原补全模型暂不可用，请重新选择':undefined} disabled={loading||!prefs.enabled||!prefs.aiEnabled} onChange={modelId=>change({...prefs,modelId})}/></label>
      <label>停止输入后触发<Select label="补全触发延迟" value={prefs.delayMs} options={[300,500,800,1000].map(value=>({value,label:`${value} ms`}))} disabled={!prefs.enabled} onChange={delayMs=>change({...prefs,delayMs})}/></label></div>
    <div className="terminal-completion-privacy">
      <div className="terminal-completion-option" title="路径和历史没有匹配时，使用所选模型续写当前输入。"><strong>AI 续写</strong><Toggle label="AI 续写" value={prefs.aiEnabled} disabled={!prefs.enabled} onChange={aiEnabled=>change({...prefs,aiEnabled})}/></div>
      <div className="terminal-completion-option" title="可选。仅发送目录路径，不发送文件正文、目录列表或命令历史。"><strong>向 AI 提供当前目录</strong><Toggle label="向 AI 提供当前目录" value={prefs.sendDirectory} disabled={!prefs.enabled||!prefs.aiEnabled} onChange={sendDirectory=>change({...prefs,sendDirectory})}/></div>
      <span className="terminal-completion-shortcut">→ 填入 · Esc 隐藏</span>
    </div>
    <details className="terminal-completion-help"><summary>接入与使用说明<span>SSH · Bash 4.4+</span></summary><div><p>适用于 SSH 的 Bash 4.4+（emacs 行编辑模式）；本地 CMD / PowerShell 暂不支持。</p>
      <p>已有 SSH 会话：回到空命令提示符，从终端操作菜单选择“重新接入 Bash 补全”，或新建 / 重连 SSH 会话。开启设置不会自动向已有终端发送初始化命令。</p>
      <p>输入至少 2 个字符后稍停，建议以灰字显示；按 → 填入，Esc 隐藏，Tab 仍使用远端原有补全。填入后需手动回车执行。路径与本次手动历史优先在应用内匹配，AI 续写仅发送当前输入，目录默认不发送，不发送文件正文、目录列表或命令历史。</p></div></details>
    {failed&&<button type="button" className="outlined-button" disabled={loading} onClick={()=>void load()}>重新读取模型</button>}
  </section>;
}

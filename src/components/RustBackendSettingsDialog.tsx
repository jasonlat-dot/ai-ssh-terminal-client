import { useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  readBundledBackendConfig, readBundledBackendAutoStart, watchBundledBackendStatus,
  restartBundledBackend, stopBundledBackend,
  saveBundledBackendConfig, setBundledBackendAutoStart,
  type BundledBackendConfig, type BundledBackendStatus,
} from '../api/bundledBackend';
import { RUST_PREVIEW_VERSION } from '../config/rustPreview';
import { isTauriRuntime } from '../state/runtime';
import { AppearanceSettings } from './AppearanceSettings';
import { ModelSettings } from './ModelSettings';
import { AgentExtensionSettings } from './AgentExtensionSettings';
import { Icon, Badge } from './Ui';
import { WindowControls } from './WindowControls';
import { dragAppWindow } from '../state/appWindow';
import { notify } from '../state/notifications';
import { settingsNavigation } from '../config/settingsNavigation';
import type { SettingsSection } from '../config/settingsNavigation';
import './BackendSettingsDialog.css';
import './RustPreview.css';

export type RustSettingsSection = SettingsSection;
type Props = {
  currentUrl: string; required?: boolean; onClose: () => void; onSave: (url: string) => void;
  beforeClientUpdate?: () => Promise<void>; showUpdates?: boolean;
  modelsChanged?: () => void; modelSettingsRequested?: boolean; modelSettingsLocked?: boolean;
  section?: RustSettingsSection;
};
export function RustBackendSettingsDialog({required=false,onClose,onSave,showUpdates=false,modelsChanged,modelSettingsRequested=false,modelSettingsLocked=false,section}:Props) {
  const desktop=isTauriRuntime();
  const [tab,setTab]=useState<RustSettingsSection>(section??(modelSettingsRequested?'models':'general'));
  const [config,setConfig]=useState<BundledBackendConfig|null>(null);
  const [status,setStatus]=useState<BundledBackendStatus|null>(null);
  const [directory,setDirectory]=useState('');
  const [autoStart,setAutoStart]=useState(true);
  const [filesEnabled,setFilesEnabled]=useState(true);
  const [capacity,setCapacity]=useState('1024');
  const [retention,setRetention]=useState('0');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{if(section)setTab(section);},[section]);
  useEffect(()=>{if(showUpdates)setTab('general');},[showUpdates]);
  useEffect(()=>{if(modelSettingsRequested)setTab('models');},[modelSettingsRequested]);
  useEffect(()=>{
    let active=true;
    void Promise.all([readBundledBackendConfig(),readBundledBackendAutoStart()])
      .then(([view,start])=>{
        if(!active)return;
        setConfig(view);
        setDirectory(view?.values.dataDirectory?.value??'');setAutoStart(start??true);
        setFilesEnabled(view?.values.fileStorageEnabled?.value!=='false');
        setCapacity(view?.values.maxStorageMiB?.value??'1024');setRetention(view?.values.fileRetentionDays?.value??'0');
      }).catch(cause=>{if(active)setError(String(cause));});
    return()=>{active=false;};
  },[]);
  useEffect(()=>watchBundledBackendStatus(setStatus,cause=>setError(String(cause))),[]);
  const operate=async(action:'restart'|'stop')=>{
    setBusy(true);setError('');
    try {
      const next=await(action==='restart'?restartBundledBackend():stopBundledBackend());
      if(next)setStatus(previous=>previous&&next.revision<previous.revision?previous:next);
      if(next?.status==='failed')throw new Error(next.message);
      const complete=action==='stop'?next?.status==='stopped':next?.status==='running';
      notify(next?.message??'工作区操作请求已提交。',complete?'success':'info');
      if(next?.backendUrl)onSave(next.backendUrl);
    } catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  const save=async()=>{
    setBusy(true);setError('');
    try {
      if(!directory.trim())throw new Error('请输入数据目录。');
      for(const [value,min,max,label] of [[capacity,20,102400,'附件容量'],[retention,0,3650,'保留天数']] as const) {if(!Number.isInteger(Number(value))||Number(value)<min||Number(value)>max)throw new Error(label+'超出允许范围。');}
      const next=await saveBundledBackendConfig({values:{dataDirectory:directory,fileStorageEnabled:String(filesEnabled),maxStorageMiB:capacity,fileRetentionDays:retention}});
      setConfig(next);notify('本地数据设置已保存，重新初始化工作区后生效。','success');
    } catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  const toggleAutoStart=async()=>{
    setBusy(true);setError('');
    try {const result=await setBundledBackendAutoStart(!autoStart);if(result!==null){setAutoStart(result);notify(result?'已开启启动时自动初始化。':'已关闭启动时自动初始化。','success');}}
    catch(cause){setError(String(cause));}finally{setBusy(false);}
  };
  return <main className={'settings-page rust-settings '+(required?'is-standalone ':'')+(section?'main-navigation-settings':'')} aria-label="Rust 试用版设置">
    <header className="settings-topbar" onMouseDown={required?dragAppWindow:undefined}>
      <div className="settings-topbar-left">
        {!required&&<button className="settings-back-button" onClick={onClose}><Icon name="left" size={16}/>返回终端</button>}
        <div className="settings-topbar-title"><h1>ShellPilot 设置</h1><p>管理本地工作区、模型连接与外观。</p></div>
      </div>
      <div className="settings-topbar-right"><Badge tone="success">应用内运行</Badge>{required&&<WindowControls/>}</div>
    </header>
    <div className="settings-body">
      {section===undefined&&<aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-list">
          {settingsNavigation.map(({section:id,label,icon,subtitle})=><button key={id} aria-label={label} title={label+' · '+subtitle} className={'settings-nav-item '+(tab===id?'selected':'')} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><span className="settings-nav-icon"><Icon name={icon} size={17}/></span><span className="settings-nav-text"><strong>{label}</strong><small>{subtitle}</small></span><Icon name="right" size={12} className="settings-nav-arrow"/></button>)}
        </div>
        <div className="settings-nav-footer">{!required&&<button type="button" className="settings-rail-back" aria-label="返回终端" title="返回终端" onClick={onClose}><Icon name="left" size={19}/></button>}<strong>v{RUST_PREVIEW_VERSION}</strong><small>独立安装 · 独立数据</small></div>
      </aside>}
      <div className="settings-content-panel" data-section={tab==='models'?'model':tab}><section className={`settings-content ${tab==='models'?'rust-model-content':''}`} data-section={tab==='models'?'model':tab}>
        {error&&<p className="settings-error" role="alert">{error}</p>}
        {tab==='appearance'&&<AppearanceSettings/>}
        {tab==='extensions'&&<AgentExtensionSettings locked={modelSettingsLocked}/>}
        {tab==='models'&&<ModelSettings changed={modelsChanged} locked={modelSettingsLocked}/>}
        {tab==='general'&&<>
          <section className="rust-service-card">
            <div><Badge tone={status?.status==='running'?'success':'amber'}>{status?.status==='running'?'运行中':status?.status==='starting'?'启动中':'未运行'}</Badge><h2>本地工作区</h2><p>{status?.message??(desktop?'正在读取工作区状态…':'请通过桌面程序使用本地工作区。')}</p></div>
            {desktop&&<div className="rust-service-actions">
              <button className="primary-button" disabled={busy||status?.status==='starting'} onClick={()=>void operate('restart')}><Icon name="refresh" size={15}/>{status?.status==='running'?'重新初始化':'初始化'}</button>
              <button className="ghost-button" disabled={busy||status?.status!=='running'} onClick={()=>void operate('stop')}>停止</button>
            </div>}
          </section>
          <p className="rust-preview-hint">在“模型设置”中添加配置后，可以打开 AI 面板进行基础文本对话。</p>
          {desktop&&config&&<section className="rust-config-card">
            <h2>本地数据设置</h2><p>保存后重新初始化工作区生效。重新初始化或停止会断开当前 SSH 终端。</p>
            <label className="rust-checkbox"><input type="checkbox" checked={autoStart} disabled={busy} onChange={()=>void toggleAutoStart()}/>打开应用时自动初始化本地工作区</label>
            <div className="rust-fields">
              <label>数据目录<input value={directory} disabled={busy} onChange={event=>setDirectory(event.target.value)}/><small>连接配置、加密凭据和附件存储在此目录。修改目录不会搬迁已有数据。</small></label>
            </div>
            <label className="rust-checkbox"><input type="checkbox" checked={filesEnabled} disabled={busy} onChange={event=>setFilesEnabled(event.target.checked)}/>启用本地附件存储</label>
            <div className="rust-fields">
              <label>附件容量（MiB）<input type="number" min="20" max="102400" value={capacity} disabled={busy} onChange={event=>setCapacity(event.target.value)}/><small>默认 1024 MiB；达到限额时停止接收新附件。</small></label>
              <label>文件保留天数<input type="number" min="0" max="3650" value={retention} disabled={busy} onChange={event=>setRetention(event.target.value)}/><small>0 为长期保留。非 0 会自动清理所有超过该天数的已有附件。</small></label>
            </div>
            <div className="rust-service-actions"><button className="primary-button" disabled={busy} onClick={()=>void save()}>保存设置</button><button className="ghost-button" onClick={()=>void revealItemInDir(config.applicationFile).catch(cause=>setError(String(cause)))}><Icon name="folder" size={15}/>配置目录</button></div>
            <details><summary>数据与日志位置</summary><p>数据库：<code>{config.sqliteFile}</code></p><p>附件目录：<code>{config.uploadDirectory}</code></p><p>日志：<code>{config.logDirectory}</code></p></details>
          </section>}
        </>}
      </section></div>
    </div>
  </main>;
}

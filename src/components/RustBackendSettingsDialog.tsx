import { useToastError } from '../state/useToastError';
import { useEffect, useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  readBundledBackendConfig, readBundledBackendAutoStart, watchBundledBackendStatus,
  restartBundledBackend, stopBundledBackend,
  saveBundledBackendConfig, setBundledBackendAutoStart,
  type BundledBackendConfig, type BundledBackendStatus, type DiagnosticLogLevel,
} from '../api/bundledBackend';
import { APP_VERSION } from '../config/appRuntime';
import { isTauriRuntime } from '../state/runtime';
import { AppearanceSettings } from './AppearanceSettings';
import { ModelSettings } from './ModelSettings';
import { AgentExtensionSettings } from './AgentExtensionSettings';
import { ClientUpdateSettings } from './ClientUpdateSettings';
import { Select } from './Select';
import { ModelNumberInput } from './ModelNumberInput';
import { Icon, Badge, Toggle, IconHeading, AccentIcon } from './Ui';
import { WindowControls } from './WindowControls';
import { dragAppWindow } from '../state/appWindow';
import { notify } from '../state/notifications';
import { settingsNavigation } from '../config/settingsNavigation';
import type { SettingsSection } from '../config/settingsNavigation';
import './BackendSettingsDialog.css';
import './AppBranding.css';
import './WorkspaceSettings.css';

export type RustSettingsSection = SettingsSection;
type Props = {
  currentUrl: string; required?: boolean; onClose: () => void; onSave: (url: string) => void;
  beforeClientUpdate?: () => Promise<void>; showUpdates?: boolean;
  modelsChanged?: () => void; modelSettingsRequested?: boolean; modelSettingsLocked?: boolean; extensionsLocked?: boolean; activeModelIds?:ReadonlySet<string>;
  section?: RustSettingsSection;
};
export function RustBackendSettingsDialog({required=false,onClose,onSave,beforeClientUpdate,showUpdates=false,modelsChanged,modelSettingsRequested=false,modelSettingsLocked=false,extensionsLocked=modelSettingsLocked,activeModelIds,section}:Props) {
  const desktop=isTauriRuntime();
  const [tab,setTab]=useState<RustSettingsSection>(showUpdates?'updates':section??(modelSettingsRequested?'models':'general'));
  const [config,setConfig]=useState<BundledBackendConfig|null>(null);
  const [status,setStatus]=useState<BundledBackendStatus|null>(null);
  const [directory,setDirectory]=useState('');
  const [autoStart,setAutoStart]=useState(true);
  const [filesEnabled,setFilesEnabled]=useState(true);
  const [capacity,setCapacity]=useState('1024');
  const [retention,setRetention]=useState('0');
  const [busy,setBusy]=useState(false);
  const [logLevel,setLogLevel]=useState<DiagnosticLogLevel>('info');
  const [logRetention,setLogRetention]=useState(7);
  const [, setError] = useToastError();
  useEffect(()=>{if(section)setTab(section);},[section]);
  useEffect(()=>{if(showUpdates)setTab('updates');},[showUpdates]);
  useEffect(()=>{if(modelSettingsRequested)setTab('models');},[modelSettingsRequested]);
  useEffect(()=>{
    let active=true;
    void Promise.all([readBundledBackendConfig(),readBundledBackendAutoStart()])
      .then(([view,start])=>{
        if(!active)return;
        setConfig(view);
        setLogLevel((view?.values.logLevel?.value as DiagnosticLogLevel)??'info');
        setLogRetention(Number(view?.values.logRetentionDays?.value??7));
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
  const changeLogLevel=async(level:DiagnosticLogLevel)=>{
    if(busy||level===logLevel)return;
    setBusy(true);
    try {
      const next=await saveBundledBackendConfig({values:{logLevel:level}});
      if(!next)throw new Error('当前环境无法保存日志设置。');
      setConfig(next);setLogLevel(level);
      notify(`日志级别已设为 ${level.toUpperCase()}，立即生效。`,'success');
    }catch(cause){setError(cause instanceof Error?cause.message:'日志设置保存失败。');}
    finally{setBusy(false);}
  };
  const changeLogRetention=async(days:number)=>{
    if(busy||days===logRetention)return;
    setBusy(true);
    try {
      const next=await saveBundledBackendConfig({values:{logRetentionDays:String(days)}});
      if(!next)throw new Error('当前环境无法保存日志设置。');
      setConfig(next);setLogRetention(days);
      notify(`日志保留时间已设为 ${days} 天，立即生效。`,'success');
    }catch(cause){setError(cause instanceof Error?cause.message:'日志设置保存失败。');}
    finally{setBusy(false);}
  };
  const toggleAutoStart=async()=>{
    setBusy(true);setError('');
    try {const result=await setBundledBackendAutoStart(!autoStart);if(result!==null){setAutoStart(result);notify(result?'已开启启动时自动初始化。':'已关闭启动时自动初始化。','success');}}
    catch(cause){setError(String(cause));}finally{setBusy(false);}
  };
  return <main className={'settings-page rust-settings '+(required?'is-standalone ':'')+(section?'main-navigation-settings':'')} aria-label="ShellPilot 设置">
    <header className="settings-topbar" onMouseDown={required?dragAppWindow:undefined}>
      <div className="settings-topbar-left">
        {!required&&<button className="settings-back-button" onClick={onClose}><Icon name="left" size={16}/>返回终端</button>}
        <div className="settings-topbar-title"><h1>ShellPilot 设置</h1><p>管理本地工作区、模型连接、外观与应用更新。</p></div>
      </div>
      <div className="settings-topbar-right"><Badge tone="success">应用内运行</Badge>{required&&<WindowControls/>}</div>
    </header>
    <div className="settings-body">
      {section===undefined&&<aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-list">
          {settingsNavigation.map(({section:id,label,icon,subtitle})=><button key={id} aria-label={label} title={label+' · '+subtitle} className={'settings-nav-item '+(tab===id?'selected':'')} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><span className="settings-nav-icon"><Icon name={icon} size={17}/></span><span className="settings-nav-text"><strong>{label}</strong><small>{subtitle}</small></span><Icon name="right" size={12} className="settings-nav-arrow"/></button>)}
        </div>
        <div className="settings-nav-footer">{!required&&<button type="button" className="settings-rail-back" aria-label="返回终端" title="返回终端" onClick={onClose}><Icon name="left" size={19}/></button>}<strong>v{APP_VERSION}</strong><small>独立安装 · 独立数据</small></div>
      </aside>}
      <div className="settings-content-panel" data-section={tab==='models'?'model':tab}><section className={`settings-content ${tab==='models'?'rust-model-content':''}`} data-section={tab==='models'?'model':tab}>
        {tab==='appearance'&&<AppearanceSettings/>}
        {tab==='updates'&&<ClientUpdateSettings beforeInstall={beforeClientUpdate}/>}
        {tab==='extensions'&&<AgentExtensionSettings locked={extensionsLocked}/>}
        {tab==='models'&&<ModelSettings changed={modelsChanged} locked={modelSettingsLocked} activeModelIds={activeModelIds}/>}
        {tab==='general'&&<section className="workspace-preferences" aria-labelledby="workspace-preferences-title">
          <header className="workspace-preferences-heading">
            <div><IconHeading as="h2" id="workspace-preferences-title" icon="workspace" tone="blue">本地工作区</IconHeading><p>管理运行状态、数据目录与附件存储。</p></div>
            <span className="workspace-version">v{APP_VERSION}</span>
          </header>
          <form className="workspace-preferences-form" onSubmit={event=>{event.preventDefault();void save();}}>
            <div className="workspace-preferences-grid">
              <div className="workspace-preferences-primary">
                <section className="workspace-runtime-bar" aria-label="工作区运行状态">
                  <AccentIcon className="workspace-section-icon" icon="workspace" tone="success" size={18}/>
                  <div className="workspace-runtime-copy"><div><strong>运行状态</strong><Badge tone={status?.status==='running'?'success':status?.status==='failed'?'rose':'amber'}>{status?.status==='running'?'运行中':status?.status==='starting'?'启动中':status?.status==='failed'?'初始化失败':'未运行'}</Badge></div><p>{status?.message??(desktop?'正在读取工作区状态…':'请在桌面程序中使用本地工作区。')}</p></div>
                  {desktop&&<div className="workspace-runtime-actions">
                    <button type="button" className="ghost-button workspace-restart" disabled={busy||status?.status==='starting'} onClick={()=>void operate('restart')}><Icon name="refresh" size={14}/>{status?.status==='running'?'重新初始化':'初始化'}</button>
                    <button type="button" className="ghost-button workspace-stop" disabled={busy||status?.status!=='running'} onClick={()=>void operate('stop')}><Icon name="stop" size={13}/>停止</button>
                  </div>}
                </section>
                {desktop&&!config&&<p className="workspace-loading" role="status">正在读取本地设置…</p>}
                {desktop&&config&&<section className="workspace-preferences-group" aria-labelledby="workspace-directory-title">
                  <header className="workspace-group-heading"><AccentIcon className="workspace-section-icon" icon="folder" tone="amber" size={18}/><div><h3 id="workspace-directory-title">启动与目录</h3><p>配置保存位置与启动行为</p></div></header>
                  <div className="workspace-preference-row"><div><strong>启动时自动初始化</strong><small>打开应用时准备工作区，修改立即保存。</small></div><Toggle label="启动时自动初始化本地工作区" value={autoStart} disabled={busy} onChange={()=>void toggleAutoStart()}/></div>
                  <div className="workspace-directory-field">
                    <label htmlFor="workspace-data-directory">数据目录</label>
                    <input className="settings-control" id="workspace-data-directory" value={directory} disabled={busy} onChange={event=>setDirectory(event.target.value)} spellCheck={false}/>
                    <div className="workspace-directory-caption"><small>连接、凭据与附件保存在此；更改路径不会搬迁旧数据。</small><button type="button" className="workspace-directory-open" title="打开当前配置文件所在目录" onClick={()=>void revealItemInDir(config.applicationFile).catch(cause=>setError(String(cause)))}><Icon name="folder" size={14}/>配置目录<Icon name="upRight" size={12}/></button></div>
                  </div>
                  <details className="workspace-location-details"><summary><Icon name="sidebar" size={14}/><span>数据与日志位置</span><Icon name="down" size={13}/></summary><dl><div><dt>数据库</dt><dd><code>{config.sqliteFile}</code></dd></div><div><dt>附件</dt><dd><code>{config.uploadDirectory}</code></dd></div><div><dt>日志</dt><dd><code>{config.logDirectory}</code></dd></div></dl></details>
                </section>}
              </div>
              {desktop&&config&&<>
                <section className="workspace-preferences-group" aria-labelledby="workspace-attachments-title">
                  <header className="workspace-group-heading"><AccentIcon className="workspace-section-icon" icon="file" tone="rose" size={18}/><div><h3 id="workspace-attachments-title">附件存储</h3><p>控制本地容量与自动清理</p></div></header>
                  <div className="workspace-preference-row"><div><strong>保存对话附件</strong><small>随本页设置一起保存，重新初始化生效。</small></div><Toggle label="启用本地附件存储" value={filesEnabled} disabled={busy} onChange={setFilesEnabled}/></div>
                  <div className="workspace-storage-grid">
                    <div className="workspace-number-field"><label htmlFor="workspace-storage-capacity">容量上限<span>MiB</span></label><ModelNumberInput id="workspace-storage-capacity" label="附件容量" kind="storage" value={Number(capacity)} disabled={busy||!filesEnabled} onChange={value=>setCapacity(String(value))}/><small>默认 1 GiB，达到上限后停止接收新附件。</small></div>
                    <div className="workspace-number-field"><label htmlFor="workspace-storage-retention">保留时间<span>天</span></label><ModelNumberInput id="workspace-storage-retention" label="文件保留天数" kind="retention" value={Number(retention)} disabled={busy||!filesEnabled} onChange={value=>setRetention(String(value))}/><small>0 为长期保留；其他值将自动删除过期附件。</small></div>
                  </div>
                </section>
                <section className="workspace-preferences-group workspace-diagnostics" aria-labelledby="workspace-diagnostics-title">
                  <header className="workspace-group-heading"><AccentIcon className="workspace-section-icon" icon="file" tone="blue" size={18}/><div><h3 id="workspace-diagnostics-title">诊断日志</h3><p>按日期与 Trace ID 保存每次请求的处理过程</p></div></header>
                  <div className="workspace-preference-row"><div><strong>日志级别</strong><small>记录所选级别及更严重的事件，自动保存并立即生效。</small></div>
                    <Select<DiagnosticLogLevel> id="workspace-log-level" label="诊断日志级别" value={logLevel} disabled={busy} options={[{value:'debug',label:'DEBUG · 调试详情'},{value:'info',label:'INFO · 常规过程'},{value:'warn',label:'WARN · 警告与错误'},{value:'error',label:'ERROR · 仅错误'}]} onChange={level=>void changeLogLevel(level)}/>
                  </div>
                  <div className="workspace-preference-row"><div><strong>日志保留时间</strong><small>默认 7 天，按本地日期清理过期请求日志；保存后立即生效。</small></div>
                    <Select<number> id="workspace-log-retention" label="日志保留时间" value={logRetention} disabled={busy} options={[1,3,7,14,30,90,365].map(days=>({value:days,label:`${days} 天`}))} onChange={days=>void changeLogRetention(days)}/>
                  </div>
                  <div className="workspace-log-location"><code>{config.traceLogDirectory??`${config.logDirectory}/agent`}</code><button type="button" className="ghost-button" onClick={()=>void openPath(config.traceLogDirectory??`${config.logDirectory}/agent`).catch(cause=>setError(String(cause)))}><Icon name="folder" size={14}/>打开日志目录</button></div>
                  <p className="workspace-diagnostics-note">INFO 记录用户消息与模型回复，并标明连接名、模型和 Trace ID；DEBUG 增加请求结构与耗时。不记录配置密钥；对话正文会明文保存在本机日志中。</p>
                </section>
              </>}
            </div>
            {desktop&&config&&<footer className="workspace-preferences-save"><span><Icon name="alert" size={14}/>目录与附件设置在重新初始化后生效；重新初始化会断开当前连接。</span><button type="submit" className="primary-button" disabled={busy}><Icon name="check" size={14}/>{busy?'处理中…':'保存设置'}</button></footer>}
          </form>
        </section>}
      </section></div>
    </div>
  </main>;
}

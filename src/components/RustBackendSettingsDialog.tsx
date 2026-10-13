import { useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  readBundledBackendConfig, readBundledBackendAutoStart, watchBundledBackendStatus,
  resolveBundledBackendUrl, restartBundledBackend, stopBundledBackend,
  saveBundledBackendConfig, setBundledBackendAutoStart,
  type BundledBackendConfig, type BundledBackendStatus,
} from '../api/bundledBackend';
import { activeBackendConnection } from '../config/backend';
import { RUST_PREVIEW_VERSION } from '../config/rustPreview';
import { isTauriRuntime } from '../state/runtime';
import { BackendConnectionSettings } from './BackendConnectionSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { Icon, Badge } from './Ui';
import { WindowControls } from './WindowControls';
import { dragAppWindow } from '../state/appWindow';
import './BackendSettingsDialog.css';
import './RustPreview.css';

type Props = {
  currentUrl: string; required?: boolean; onClose: () => void; onSave: (url: string) => void;
  beforeClientUpdate?: () => Promise<void>; showUpdates?: boolean;
};
export function RustBackendSettingsDialog({currentUrl,required=false,onClose,onSave,showUpdates=false}:Props) {
  const desktop=isTauriRuntime();
  const [tab,setTab]=useState<'general'|'appearance'|'about'>(showUpdates?'about':'general');
  const [config,setConfig]=useState<BundledBackendConfig|null>(null);
  const [status,setStatus]=useState<BundledBackendStatus|null>(null);
  const [port,setPort]=useState('0');
  const [directory,setDirectory]=useState('');
  const [autoStart,setAutoStart]=useState(true);
  const [filesEnabled,setFilesEnabled]=useState(true);
  const [capacity,setCapacity]=useState('1024');
  const [retention,setRetention]=useState('0');
  const [linkMinutes,setLinkMinutes]=useState('15');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  useEffect(()=>{if(showUpdates)setTab('about');},[showUpdates]);
  useEffect(()=>{
    let active=true;
    void Promise.all([readBundledBackendConfig(),readBundledBackendAutoStart()])
      .then(([view,start])=>{
        if(!active)return;
        setConfig(view);setPort(view?.values.serverPort?.value??'0');
        setDirectory(view?.values.dataDirectory?.value??'');setAutoStart(start??true);
        setFilesEnabled(view?.values.fileStorageEnabled?.value!=='false');
        setCapacity(view?.values.maxStorageMiB?.value??'1024');setRetention(view?.values.fileRetentionDays?.value??'0');setLinkMinutes(view?.values.downloadLinkMinutes?.value??'15');
      }).catch(cause=>{if(active)setError(String(cause));});
    return()=>{active=false;};
  },[]);
  useEffect(()=>watchBundledBackendStatus(setStatus,cause=>setError(String(cause))),[]);
  const localUrl=resolveBundledBackendUrl(status,config);
  const operate=async(action:'restart'|'stop')=>{
    setBusy(true);setError('');setMessage('');
    try {
      const next=await(action==='restart'?restartBundledBackend():stopBundledBackend());
      if(next)setStatus(previous=>previous&&next.revision<previous.revision?previous:next);
      if(next?.status==='failed')throw new Error(next.message);
      setMessage(next?.message??'操作已完成');
      if(next?.backendUrl&&activeBackendConnection().kind==='builtin')onSave(next.backendUrl);
    } catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  const save=async()=>{
    setBusy(true);setError('');setMessage('');
    try {
      if(!Number.isInteger(Number(port))||Number(port)<0||Number(port)>65535)throw new Error('请输入 0 到 65535 的端口号。');
      if(!directory.trim())throw new Error('请输入数据目录。');
      for(const [value,min,max,label] of [[capacity,20,102400,'附件容量'],[retention,0,3650,'保留天数'],[linkMinutes,1,10080,'链接有效期']] as const) {if(!Number.isInteger(Number(value))||Number(value)<min||Number(value)>max)throw new Error(label+'超出允许范围。');}
      const next=await saveBundledBackendConfig({values:{serverPort:port,dataDirectory:directory,fileStorageEnabled:String(filesEnabled),maxStorageMiB:capacity,fileRetentionDays:retention,downloadLinkMinutes:linkMinutes}});
      setConfig(next);setMessage('设置已保存，重启内置服务后生效。');
    } catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  const toggleAutoStart=async()=>{
    setBusy(true);setError('');
    try {const result=await setBundledBackendAutoStart(!autoStart);if(result!==null)setAutoStart(result);}
    catch(cause){setError(String(cause));}finally{setBusy(false);}
  };
  return <main className={'settings-page rust-settings '+(required?'is-standalone':'')} aria-label="Rust 试用版设置">
    <header className="settings-topbar" onMouseDown={required?dragAppWindow:undefined}>
      <div className="settings-topbar-left">
        {!required&&<button className="settings-back-button" onClick={onClose}><Icon name="left" size={16}/>返回终端</button>}
        <div className="settings-topbar-title"><h1>ShellPilot · Rust 试用版</h1><p>SSH 终端、SFTP 文件管理与本地命令可用。</p></div>
      </div>
      <div className="settings-topbar-right"><Badge tone="success">Rust 内置后端</Badge>{required&&<WindowControls/>}</div>
    </header>
    <div className="settings-body">
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-list">
          {([['general','连接与服务','settings'],['appearance','外观','monitor'],['about','关于试用版','terminal']] as const).map(([id,label,icon])=><button key={id} className={'settings-nav-item '+(tab===id?'selected':'')} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><Icon name={icon} size={17}/><span className="settings-nav-text"><strong>{label}</strong></span></button>)}
        </div>
        <div className="settings-nav-footer"><strong>v{RUST_PREVIEW_VERSION}</strong><small>独立安装 · 独立数据</small></div>
      </aside>
      <div className="settings-content-panel"><section className="settings-content">
        {error&&<p className="settings-error" role="alert">{error}</p>}
        {message&&<p className="rust-settings-notice" role="status">{message}</p>}
        {tab==='appearance'&&<AppearanceSettings/>}
        {tab==='about'&&<div className="rust-about">
          <Badge tone="success">Rust Preview</Badge><h2>轻量的桌面 SSH 终端</h2>
          <p>客户端和 Rust 后端运行在同一个程序中，无需安装 Java 或启动独立数据库。</p>
          <div className="rust-feature-grid"><article><Icon name="terminal"/><h3>现在可用</h3><p>连接管理、密码与私钥认证、SSH 终端、多窗口与分屏、常用命令、本地 CMD、SFTP 文件管理、独立附件上传下载和存储管理。</p></article><article><Icon name="folder"/><h3>后续迁移</h3><p>AI 对话、聊天附件发送与自动执行任务。</p></article></div>
          <p>试用版与原版本使用不同的数据目录。自动更新已关闭，后续使用新的试用安装包更新。</p>
        </div>}
        {tab==='general'&&<>
          <section className="rust-service-card">
            <div><Badge tone={status?.status==='running'?'success':'amber'}>{status?.status==='running'?'运行中':status?.status==='starting'?'启动中':'未运行'}</Badge><h2>Rust 内置服务</h2><p>{status?.message??(desktop?'正在读取服务状态…':'浏览器预览使用已启动的本机 Rust 服务。')}</p><code>{localUrl??currentUrl}</code></div>
            {desktop&&<div className="rust-service-actions">
              <button className="primary-button" disabled={busy||status?.status==='starting'} onClick={()=>void operate('restart')}><Icon name="refresh" size={15}/>{status?.status==='running'?'重启服务':'启动服务'}</button>
              <button className="ghost-button" disabled={busy||status?.status!=='running'} onClick={()=>void operate('stop')}>停止</button>
            </div>}
          </section>
          <p className="rust-preview-hint">支持 SSH、SFTP 和独立附件存储；AI 聊天将在后续阶段接入。</p>
          <BackendConnectionSettings localUrl={localUrl} onUse={onSave}/>
          {desktop&&config&&<section className="rust-config-card">
            <h2>本机运行设置</h2><p>保存后重启生效。重启或停止服务会断开当前 SSH 终端。</p>
            <label className="rust-checkbox"><input type="checkbox" checked={autoStart} disabled={busy} onChange={()=>void toggleAutoStart()}/>打开客户端时自动启动内置服务</label>
            <div className="rust-fields">
              <label>监听端口<input type="number" min="0" max="65535" value={port} disabled={busy} onChange={event=>setPort(event.target.value)}/><small>0 表示自动选择空闲端口，适合试装。</small></label>
              <label>数据目录<input value={directory} disabled={busy} onChange={event=>setDirectory(event.target.value)}/><small>连接配置、加密凭据和附件存储在此目录。修改目录不会搬迁已有数据。</small></label>
            </div>
            <label className="rust-checkbox"><input type="checkbox" checked={filesEnabled} disabled={busy} onChange={event=>setFilesEnabled(event.target.checked)}/>启用本地附件存储</label>
            <div className="rust-fields">
              <label>附件容量（MiB）<input type="number" min="20" max="102400" value={capacity} disabled={busy} onChange={event=>setCapacity(event.target.value)}/><small>默认 1024 MiB；达到限额时停止接收新附件。</small></label>
              <label>文件保留天数<input type="number" min="0" max="3650" value={retention} disabled={busy} onChange={event=>setRetention(event.target.value)}/><small>0 为长期保留。非 0 会自动清理所有超过该天数的已有附件。</small></label>
              <label>链接有效期（分钟）<input type="number" min="1" max="10080" value={linkMinutes} disabled={busy} onChange={event=>setLinkMinutes(event.target.value)}/><small>默认 15 分钟，过期后可以刷新。服务重启使旧签名失效。</small></label>
            </div>
            <div className="rust-service-actions"><button className="primary-button" disabled={busy} onClick={()=>void save()}>保存设置</button><button className="ghost-button" onClick={()=>void revealItemInDir(config.applicationFile).catch(cause=>setError(String(cause)))}><Icon name="folder" size={15}/>配置目录</button></div>
            <details><summary>数据与日志位置</summary><p>数据库：<code>{config.sqliteFile}</code></p><p>附件目录：<code>{config.uploadDirectory}</code></p><p>日志：<code>{config.logDirectory}</code></p></details>
          </section>}
        </>}
      </section></div>
    </div>
  </main>;
}

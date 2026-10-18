import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { clientUpdater, useClientUpdater } from '../state/useClientUpdater';
import { isTauriRuntime } from '../state/runtime';
import { Badge, Icon, IconHeading } from './Ui';
import { APP_VERSION } from '../config/rustPreview';
import './ClientUpdateSettings.css';

const RELEASES_URL = 'https://github.com/jasonlat-dot/ai-ssh-terminal-client/releases';
const sizes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function ClientUpdateSettings({ beforeInstall = async () => {} }: { beforeInstall?: () => Promise<void> }) {
  const state = useClientUpdater();
  const [confirming, setConfirming] = useState(false);
  const [linkError, setLinkError] = useState('');
  const busy = ['initializing', 'checking', 'downloading', 'preparing', 'installing'].includes(state.phase);
  const enabled = state.config?.configured && state.config.supported && !state.config.development;
  const canCheck = enabled || (!state.config && state.phase === 'error' && isTauriRuntime());
  const progress = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  const disabledReason = !state.config ? '正在读取客户端更新配置…'
    : !isTauriRuntime() ? '浏览器预览不支持安装更新，请使用桌面安装版。'
    : state.config.development ? '开发模式不检查或安装更新，请在正式安装版中验证。'
    : !state.config.configured ? '更新尚未启用：请检查更新地址与签名公钥配置，并重新构建安装包。'
    : !state.config.supported ? '当前发布流程仅支持 Windows 客户端更新。' : '';
  const labels = { idle: '可以检查新版本', initializing: '正在读取更新配置…', disabled: disabledReason,
    checking: '正在检查新版本…', current: '当前已是最新版本', available: `发现新版本 ${state.version}`,
    downloading: '正在下载并校验更新…', downloaded: '更新包已下载，签名校验通过', preparing: '正在保存会话并准备安装…',
    installing: '正在启动安装程序…', error: '更新操作未完成' };
  return <div className="client-update-settings">
    <section className="client-update-card" aria-labelledby="client-update-title">
      <header><div><IconHeading as="h2" id="client-update-title" icon="refresh" tone="blue">关于与更新</IconHeading>
        <p>更新只在确认后安装，不会自动关闭终端。</p></div><Badge icon="monitor">Windows</Badge></header>
      <div className="client-update-version"><strong>ShellPilot</strong><Badge tone="blue">v{state.config?.version ?? APP_VERSION}</Badge></div>
      <p className="client-update-status" role="status" aria-live="polite">{labels[state.phase]}</p>
      {state.error && <p className="settings-banner is-error" role="alert"><Icon name="alert" size={14} />{state.error}</p>}
      {state.checkedAt && <small>上次检查：{new Date(state.checkedAt).toLocaleString()}</small>}
      <div className="client-update-actions">
        <button type="button" className="ghost-button" disabled={busy || !canCheck || state.verified}
          onClick={() => { setConfirming(false); void clientUpdater.check(); }}><Icon name="refresh" size={14} />检查更新</button>
        {state.version && !state.verified && <button type="button" className="primary-button" disabled={busy || !enabled}
          onClick={() => { void clientUpdater.download(); }}><Icon name="down" size={14} />{state.phase === 'error' ? '重新下载' : '下载更新'}</button>}
        {state.verified && <button type="button" className="primary-button" disabled={busy || !enabled}
          onClick={() => setConfirming(true)}><Icon name="play" size={14} />安装并重启</button>}
        {state.version && <button type="button" className="ghost-button" disabled={busy}
          onClick={() => { setConfirming(false); void clientUpdater.discard(); }}>暂不更新</button>}
      </div>
      {state.phase === 'downloading' && <div className="client-update-progress">
        <progress max={100} value={progress ?? undefined} aria-label="更新下载进度" />
        <small>{sizes(state.downloaded)}{state.total ? ` / ${sizes(state.total)} · ${progress}%` : ' · 下载中'}</small>
      </div>}
      {confirming && <div className="client-update-confirm" role="group" aria-label="确认安装更新">
        <strong><Icon name="alert" size={16} />安装 v{state.version} 并重启？</strong>
        <p>会关闭所有本地 CMD、SSH 终端和文件传输，并停止内置服务。请先结束正在执行的任务；未发送的输入草稿不会自动保存。配置、历史记录和壁纸不会主动删除。</p>
        <div className="client-update-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => {
            setConfirming(false); void clientUpdater.install(beforeInstall);
          }}>确认安装并重启</button>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
        </div>
      </div>}
    </section>
    {state.version && <section className="client-update-card"><IconHeading icon="file" tone="amber">v{state.version} 更新说明</IconHeading>
      {state.date && <small>{state.date}</small>}<pre className="client-update-notes">{state.notes || '此版本未提供更新说明。'}</pre></section>}
    <section className="client-update-card"><IconHeading icon="github" tone="neutral">发布来源</IconHeading>
      <p>jasonlat-dot / ai-ssh-terminal-client · GitHub Releases</p>
      <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="client-update-release-link" onClick={event => {
        if (!isTauriRuntime()) return;
        event.preventDefault(); setLinkError('');
        void openUrl(RELEASES_URL).catch(() => setLinkError('无法打开发布页面，请检查系统浏览器。'));
      }}>查看全部版本<Icon name="upRight" size={14} /></a>
      {linkError && <p role="alert">{linkError}</p>}
      <small>旧版 0.1.4 需手动覆盖安装一次带更新功能的版本，之后才可在此升级。</small>
    </section>
  </div>;
}

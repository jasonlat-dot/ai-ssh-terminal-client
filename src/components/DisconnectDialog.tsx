import { useRef, useState } from 'react';
import type { Host } from '../types';
import { Icon, Modal } from './Ui';
import './DisconnectDialog.css';

export type DisconnectOptions = { closeRelated: boolean; keepHistory: boolean };

export function DisconnectDialog({ host, busy, error, close, confirm }: {
  host: Host; busy: boolean; error: string; close: () => void;
  confirm: (options: DisconnectOptions) => Promise<boolean>;
}) {
  const [closeRelated, setCloseRelated] = useState(true);
  const [keepHistory, setKeepHistory] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const pending = busy || submitting;
  const submit = async () => {
    if (pending || locked.current) return;
    locked.current = true; setSubmitting(true); setAttempted(true);
    try { await confirm({ closeRelated, keepHistory }); }
    finally { locked.current = false; setSubmitting(false); }
  };
  return <Modal title="确认断开当前连接？" className="disconnect-dialog" dismissDisabled={pending} onClose={close}>
    <div className="disconnect-intro">
      <span className="disconnect-warning" aria-hidden="true"><b>!</b></span>
      <p>你正在与主机 <strong>{host.name}</strong> 建立的 SSH 连接将被断开。<br />断开后，当前终端会话将停止，未保存的内容可能会丢失。</p>
    </div>
    <div className="disconnect-host">
      <span className="disconnect-server"><Icon name="server" size={36} /></span>
      <dl>
        <div><dt>主机名称</dt><dd title={host.name}>{host.name}</dd></div>
        <div><dt>主机地址</dt><dd title={`${host.address}:${host.port ?? 22}`}>{host.address}:{host.port ?? 22}</dd></div>
        <div><dt>环境</dt><dd><span className="disconnect-environment">{host.environment || '开发'}</span></dd></div>
        <div><dt>状态</dt><dd className={host.online ? 'disconnect-online' : ''}><i />{host.online ? '在线' : '未连接'}</dd></div>
      </dl>
    </div>
    <div className="disconnect-options">
      <div className="disconnect-checks">
        <label><input type="checkbox" checked={closeRelated} disabled={pending} onChange={event => setCloseRelated(event.target.checked)} /><span><strong>同时结束关联终端会话</strong><small>{closeRelated ? '关闭所有与该主机相关的终端标签页。' : '仅关闭当前标签，其他关联标签将保留为离线。'}</small></span></label>
        <label><input type="checkbox" checked={keepHistory} disabled={pending} onChange={event => setKeepHistory(event.target.checked)} /><span><strong>保留连接记录</strong><small>在本机保留断开时间与主机信息，可在设置中查看。</small></span></label>
      </div>
      <div className="disconnect-mascot" aria-hidden="true">
        <span className="disconnect-bubble">安全第一！<br />期待下次再见！</span>
        <div className="disconnect-robot"><i className="robot-antenna" /><div className="robot-head"><div className="robot-face"><i /><i /></div></div><div className="robot-body"><Icon name="terminal" size={22} /></div><i className="robot-hand" /></div>
      </div>
    </div>
    {attempted && error && !pending && <p role="alert" className="disconnect-error">{error} 终端已保留，请重试。</p>}
    <div className="disconnect-actions">
      <button data-autofocus className="outlined-button" disabled={pending} onClick={close}>取消</button>
      <button className="outlined-button" disabled={pending} onClick={close}><Icon name="history" size={19} />稍后处理</button>
      <button className="disconnect-confirm" disabled={pending} onClick={submit}>{submitting ? '正在断开…' : '确认断开'}</button>
    </div>
  </Modal>;
}

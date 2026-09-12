import { useRef, useState } from 'react';
import type { Host } from '../types';
import { Icon, Modal } from './Ui';
import './DisconnectDialog.css';

export function DisconnectDialog({ host, busy, error, close, confirm }: {
  host: Host; busy: boolean; error: string; close: () => void;
  confirm: () => Promise<boolean>;
}) {
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const pending = busy || submitting;
  const submit = async () => {
    if (pending || locked.current) return;
    locked.current = true; setSubmitting(true); setAttempted(true);
    try { await confirm(); }
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
        <div><dt>状态</dt><dd className={host.online ? 'disconnect-online' : ''}><i />{host.online ? '在线' : '未连接'}</dd></div>
      </dl>
    </div>
    {attempted && error && !pending && <p role="alert" className="disconnect-error">{error} 终端已保留，请重试。</p>}
    <div className="disconnect-actions">
      <button data-autofocus className="outlined-button" disabled={pending} onClick={close}>取消</button>
      <button className="disconnect-confirm" disabled={pending} onClick={submit}>{submitting ? '正在断开…' : '断开连接'}</button>
    </div>
  </Modal>;
}

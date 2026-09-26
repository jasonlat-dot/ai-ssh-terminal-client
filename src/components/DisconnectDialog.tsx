import { useRef, useState } from 'react';
import type { Host } from '../types';
import { Icon, Modal } from './Ui';
import './DisconnectDialog.css';

export function DisconnectDialog({ host, connected, busy, error, close, confirm }: {
  host: Host; connected: boolean; busy: boolean; error: string; close: () => void;
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
  return <Modal title={connected ? '关闭终端会话？' : '关闭终端页签？'} className="disconnect-dialog" dismissDisabled={pending} onClose={close}>
    <div className="disconnect-intro">
      <p>{connected ? '关闭后会结束此页签的 Shell 会话，请确认没有需要保留的任务。' : '此终端已断开，可以直接关闭页签。'}</p>
    </div>
    <div className="disconnect-host">
      <span className="disconnect-server"><Icon name="terminal" size={22} /></span>
      <dl>
        <div><dt>当前终端</dt><dd title={host.name}>{host.name}</dd></div>
        <div><dt>连接地址</dt><dd title={`${host.user}@${host.address}:${host.port ?? 22}`}>{host.user}@{host.address}:{host.port ?? 22}</dd></div>
      </dl>
    </div>
    {attempted && error && !pending && <p role="alert" className="disconnect-error">{error} 终端已保留，请重试。</p>}
    <div className="disconnect-actions">
      <button data-autofocus className="outlined-button" disabled={pending} onClick={close}>取消</button>
      <button className="disconnect-confirm" disabled={pending} onClick={submit}>{submitting ? '正在关闭…' : connected ? '断开并关闭' : '关闭页签'}</button>
    </div>
  </Modal>;
}

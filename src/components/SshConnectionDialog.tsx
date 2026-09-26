import { useState } from 'react';
import type { ConnectionDraft } from '../api/ssh';
import type { Host } from '../types';
import type { useSshConnections } from '../state/useSshConnections';
import { Icon, Modal } from './Ui';

export const blankSshConnection: Host = {
  id: '', name: '', address: '', user: 'root', port: 22,
  environment: '开发', auth: 'password', keyPath: '', saved: true,
};

type Props = {
  connections: ReturnType<typeof useSshConnections>;
  initial?: ConnectionDraft;
  connectAfterSave?: boolean;
  onClose: () => void;
  onSaved?: (host: Host) => void;
};

export function SshConnectionDialog({ connections, initial = blankSshConnection, connectAfterSave = false, onClose, onSaved }: Props) {
  const { hosts, save, busy } = connections;
  const [draft, setDraft] = useState<ConnectionDraft>(() => ({
    ...initial,
    connectTimeout: initial.connectTimeout ?? 10,
    keepaliveInterval: initial.keepaliveInterval ?? 30,
    compression: initial.compression ?? true,
    strictHostKeyCheck: initial.strictHostKeyCheck ?? true,
  }));
  const [error, setError] = useState('');
  const editing = !!draft.id;

  const submit = async () => {
    if (busy) return;
    const next = { ...draft, name: draft.name.trim(), address: draft.address.trim(), user: draft.user.trim(), keyPath: draft.keyPath?.trim() };
    if (!next.name || !next.address || !next.user) { setError('请填写连接名称、主机地址和用户名。'); return; }
    if (/[\s/@?#]/.test(next.address) || next.address.includes('://')) { setError('主机地址请填写 IP 或域名，不要包含协议、路径或空格。'); return; }
    if (!Number.isInteger(next.port) || next.port! < 1 || next.port! > 65535) { setError('端口必须是 1–65535 之间的整数。'); return; }
    if (!Number.isInteger(next.connectTimeout) || next.connectTimeout! < 1) { setError('连接超时时间必须是大于 0 的整数。'); return; }
    if (!Number.isInteger(next.keepaliveInterval) || next.keepaliveInterval! < 0) { setError('保活间隔必须是大于或等于 0 的整数。'); return; }
    if (next.auth === 'password' && hosts.find(host => host.id === next.id)?.auth === 'key') { setError('当前接口无法清除已有私钥，请新建密码认证连接。'); return; }
    const credentialsRequired = !next.id || hosts.find(host => host.id === next.id)?.auth !== next.auth;
    if (credentialsRequired && !(next.auth === 'key' ? next.privateKey?.trim() : next.password)) { setError(next.auth === 'key' ? '请填写私钥内容。' : '请填写 SSH 密码。'); return; }
    if (hosts.some(host => host.id !== next.id && host.address.toLowerCase() === next.address.toLowerCase() && (host.port ?? 22) === next.port && host.user === next.user)) { setError('已存在相同地址、端口和用户的连接。'); return; }
    const saved = await save(next);
    if (saved) { onClose(); onSaved?.(saved); }
  };

  return <Modal title={editing ? '编辑 SSH 连接' : '新建 SSH 连接'} onClose={onClose} className="ssh-connection-modal" dismissDisabled={busy}>
    <div className="ssh-dialog-intro">
      <span className="ssh-dialog-symbol" aria-hidden="true"><Icon name="server" size={22} /></span>
      <p>{editing ? '更新服务器信息与登录方式' : '保存你的服务器，随时开启远程会话'}</p>
    </div>
    <div className="ssh-dialog-layout">
      <form className="ssh-dialog-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={busy}>
          <section className="ssh-form-section" aria-label="服务器信息">
          <h3 className="ssh-form-section-heading">服务器信息</h3>
          <div className="ssh-dialog-grid ssh-server-grid">
            <label>连接名称<input data-autofocus required maxLength={60} placeholder="例如：Web 服务器" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>用户名<input required maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="root" value={draft.user} onChange={event => setDraft({ ...draft, user: event.target.value })} /></label>
            <div className="ssh-endpoint-grid ssh-full-field">
              <label>主机地址<input required maxLength={253} autoCapitalize="none" spellCheck={false} placeholder="IP 地址或域名" value={draft.address} onChange={event => setDraft({ ...draft, address: event.target.value })} /></label>
              <label>端口<input type="number" required min={1} max={65535} value={draft.port ?? ''} onChange={event => setDraft({ ...draft, port: event.target.valueAsNumber })} /></label>
            </div>
          </div>
          </section>
          <section className="ssh-form-section" aria-label="身份认证">
          <div className="ssh-auth-choice">
          <h3 className="ssh-form-section-heading" id="ssh-auth-label">身份认证</h3>
          <div className="ssh-auth-switch" data-method={draft.auth ?? 'password'} role="radiogroup" aria-labelledby="ssh-auth-label">
            <label className={(draft.auth ?? 'password') === 'password' ? 'selected' : ''}>
              <input type="radio" name="ssh-auth-method" value="password" checked={(draft.auth ?? 'password') === 'password'} onChange={() => setDraft({ ...draft, auth: 'password' })} />
              <Icon name="key" size={15} /><span>密码</span>
            </label>
            <label className={draft.auth === 'key' ? 'selected' : ''}>
              <input type="radio" name="ssh-auth-method" value="key" checked={draft.auth === 'key'} onChange={() => setDraft({ ...draft, auth: 'key' })} />
              <Icon name="shield" size={15} /><span>SSH 私钥</span>
            </label>
          </div>
          </div>
          {draft.auth === 'key'
            ? <label key="key" className="ssh-credential-field">私钥内容<textarea rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={editing ? '留空保留原私钥；更换认证方式时必填' : '粘贴完整 PEM / OpenSSH 私钥内容'} value={draft.privateKey ?? ''} onChange={event => setDraft({ ...draft, privateKey: event.target.value })} /></label>
            : <label key="password" className="ssh-credential-field">SSH 密码<input type="password" autoComplete="new-password" placeholder={editing ? '留空保留原密码；更换认证方式时必填' : '输入登录密码'} value={draft.password ?? ''} onChange={event => setDraft({ ...draft, password: event.target.value })} /></label>}
          </section>
          <details className="ssh-advanced-settings">
            <summary><span><Icon name="settings" size={15} />高级设置</span><Icon name="down" size={15} /></summary>
            <div className="ssh-dialog-grid">
              <label>连接超时（秒）<input type="number" required min={1} step={1} value={draft.connectTimeout ?? ''} onChange={event => setDraft({ ...draft, connectTimeout: event.target.value === '' ? undefined : event.target.valueAsNumber })} /></label>
              <label>保活间隔（秒）<input type="number" required min={0} step={1} value={draft.keepaliveInterval ?? ''} onChange={event => setDraft({ ...draft, keepaliveInterval: event.target.value === '' ? undefined : event.target.valueAsNumber })} /></label>
              <label className="ssh-full-field">启动命令<input placeholder="可选，例如：cd /var/www/app" value={draft.startupCommand ?? ''} onChange={event => setDraft({ ...draft, startupCommand: event.target.value })} /></label>
              <div className="ssh-setting-field"><span>压缩</span><div className="ssh-boolean-switch" role="radiogroup" aria-label="压缩"><button type="button" role="radio" aria-checked={draft.compression === true} className={draft.compression === true ? 'selected' : ''} onClick={() => setDraft({ ...draft, compression: true })}>开启</button><button type="button" role="radio" aria-checked={draft.compression === false} className={draft.compression === false ? 'selected' : ''} onClick={() => setDraft({ ...draft, compression: false })}>关闭</button></div></div>
              <div className="ssh-setting-field"><span>严格主机密钥检查</span><div className="ssh-boolean-switch" role="radiogroup" aria-label="严格主机密钥检查"><button type="button" role="radio" aria-checked={draft.strictHostKeyCheck === true} className={draft.strictHostKeyCheck === true ? 'selected' : ''} onClick={() => setDraft({ ...draft, strictHostKeyCheck: true })}>开启</button><button type="button" role="radio" aria-checked={draft.strictHostKeyCheck === false} className={draft.strictHostKeyCheck === false ? 'selected' : ''} onClick={() => setDraft({ ...draft, strictHostKeyCheck: false })}>关闭</button></div></div>
            </div>
          </details>
        </fieldset>
        {error && <p role="alert" className="form-error">{error}</p>}
        <footer><div className="dialog-actions">
          <button type="button" className="outlined-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : editing ? '保存修改' : connectAfterSave ? '保存并连接' : '保存连接'}</button></div></footer>
      </form>
    </div>
  </Modal>;
}

import { useEffect, useRef, useState } from 'react';
import {
  activateBackendConnection, activeBackendConnection, BUILTIN_BACKEND_ID, deleteBackendConnection,
  readBackendConnections, saveBackendConnection, type BackendConnectionProfile,
} from '../config/backend';
import { prepareBackendConnectionTls } from '../api/backendFetch';
import { probeBackendConnection } from '../api/backendConnectionProbe';
import { readBundledBackendStatus, restartBundledBackend } from '../api/bundledBackend';
import { isTauriRuntime } from '../state/runtime';
import { Select } from './Select';
import { Badge, Icon } from './Ui';

/** 只描述本次界面操作，不能把健康检查成功当成已保存、已切换或业务鉴权通过。 */
type ConnectionNotice = { title: string; detail: string; latencyMs?: number };

/**
 * 连接档案只属于客户端，保存不会写 Java/Nginx 配置。
 * “保存”保留档案，“使用”明确切换；内置地址从实际服务状态获取，不被远程编辑覆盖。
 */
export function BackendConnectionSettings({ localUrl, onUse }: {
  localUrl: string | null;
  onUse: (url: string) => void;
}) {
  const [connections, setConnections] = useState(readBackendConnections);
  const [draft, setDraft] = useState<BackendConnectionProfile>(() => activeBackendConnection());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ConnectionNotice | null>(null);
  const [testing, setTesting] = useState(false);
  const certificateInput = useRef<HTMLInputElement>(null);
  // 文件名仅用于展示；连接档案仍只保存公开 PEM 内容，不保存文件路径。
  const [importedFile, setImportedFile] = useState<{ name: string; pem: string } | null>(null);
  const [error, setError] = useState('');
  const [responseDetail, setResponseDetail] = useState<{ httpStatus: number | null; body: string } | null>(null);
  const builtin = draft.kind === 'builtin';
  // 查看/编辑对象与真正活动连接分开；下拉选项不能伪装成已经切换成功。
  const currentConnection = connections.profiles.find(profile => profile.id === connections.activeId);
  const pendingUse = draft.id !== connections.activeId;
  const hasCertificate = Boolean(draft.certificatePem.trim());
  const certificateName = importedFile?.pem === draft.certificatePem ? importedFile.name
    : hasCertificate ? '已载入公开证书内容' : '导入服务器公开证书';

  useEffect(() => {
    if (localUrl && draft.kind === 'builtin') setDraft(previous => ({ ...previous, url: localUrl }));
  }, [localUrl, draft.kind]);

  const change = (patch: Partial<BackendConnectionProfile>) => {
    setDraft(previous => ({ ...previous, ...patch })); setError(''); setMessage(null); setResponseDetail(null);
  };
  const select = (id: string) => {
    const profile = connections.profiles.find(item => item.id === id);
    if (profile) setDraft({ ...profile, url: profile.kind === 'builtin' ? localUrl || profile.url : profile.url });
    setError(''); setMessage(null); setResponseDetail(null); setImportedFile(null);
  };

  /** 切换前保留原活动 ID；证书准备失败时恢复，不让失败连接污染内置后端。 */
  const save = async (use: boolean) => {
    setBusy(true); setError(''); setMessage(null); setResponseDetail(null);
    const previous = activeBackendConnection();
    let activated = false;
    try {
      let selectedUrl = builtin ? localUrl || draft.url : draft.url;
      if (use && builtin && isTauriRuntime()) {
        // 用户明确选择内置后端时按需启动；选择远程不会拉起或修改本机 Java。
        let status = await readBundledBackendStatus();
        if (status?.status !== 'running') status = await restartBundledBackend();
        if (status?.status !== 'running' || !status.backendUrl) {
          throw new Error(status?.message || '内置后端尚未就绪，请检查本机配置后重试。');
        }
        selectedUrl = status.backendUrl;
      }
      // 正在使用的档案不能只改磁盘而让页面继续显示旧地址：此时明确执行“保存并使用”。
      const activate = use || previous.id === draft.id;
      const saved = saveBackendConnection({ ...draft, url: selectedUrl });
      setDraft(saved); setConnections(readBackendConnections());
      if (activate) {
        activateBackendConnection(saved.id); activated = true;
        await prepareBackendConnectionTls();
        // onUse 不一定卸载此组件，成功后的“当前连接”也必须反映真实活动 ID。
        setConnections(readBackendConnections());
        onUse(saved.url);
      } else setMessage({ title: '连接已保存', detail: '当前使用的后端没有变化。' });
    } catch (cause) {
      if (activated) {
        // 若修改的是活动档案，连其地址/证书也恢复，不能只恢复同一个 ID。
        saveBackendConnection(previous); activateBackendConnection(previous.id);
        await prepareBackendConnectionTls().catch(() => undefined);
        setConnections(readBackendConnections());
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  /** 草稿测试使用独立原生请求；不能通过临时激活档案来“借用”另一连接的证书信任。 */
  const test = async () => {
    setBusy(true); setTesting(true); setError(''); setMessage(null); setResponseDetail(null);
    try {
      const result = await probeBackendConnection({ ...draft });
      if (!result.ok) {
        if (result.responseBody) setResponseDetail({ httpStatus: result.httpStatus ?? null, body: result.responseBody });
        throw new Error(result.message || '健康检查未通过。');
      }
      setMessage({ title: '独立连接测试通过', latencyMs: result.latencyMs,
        detail: '健康状态 UP。未保存或切换当前连接；业务登录与 WebView 跨域仍需另行验证。' });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); setTesting(false); }
  };

  return <div className="settings-connection-editor">
    <p className="settings-field-help">当前正在使用：<strong>{currentConnection?.name}</strong>。
      下拉框仅选择查看或编辑对象，不会立即切换后端。</p>
    <div className="settings-connection-toolbar">
      <Select label="查看或编辑后端连接" value={draft.id} disabled={busy}
        options={[...connections.profiles.map(profile => ({ value: profile.id, label: profile.name })),
          ...(!connections.profiles.some(profile => profile.id === draft.id) ? [{ value: draft.id, label: '新远程连接' }] : [])]}
        onChange={select} className="settings-control" />
      <button type="button" className="ghost-button" disabled={busy} onClick={() => {
        setDraft({ id: crypto.randomUUID(), name: '', kind: 'remote', url: '', trust: 'system', certificatePem: '' });
        setError(''); setMessage(null); setResponseDetail(null); setImportedFile(null);
      }}><Icon name="plus" size={13} />新增远程连接</button>
    </div>
    {pendingUse && <div className="settings-connection-notice" data-accent="blue" role="status">
      <span className="settings-connection-notice-icon" aria-hidden="true"><Icon name="signal" size={20} /></span>
      <div className="settings-connection-notice-copy">
        <strong>{draft.name.trim() || '新远程连接'}：已选择，尚未使用</strong>
        <p>当前仍使用「{currentConnection?.name}」。点击「{builtin ? '切回内置后端' : '使用此连接'}」才会切换。
          底部「保存内置后端配置」只保存本机 YAML，不保存或应用此连接。</p>
      </div>
    </div>}
    <fieldset disabled={busy} className="settings-connection-fields">
      {!builtin && <div className="settings-field">
        <label htmlFor="connection-name">连接名称</label>
        <input id="connection-name" className="settings-control" value={draft.name} placeholder="例如：生产服务器"
          onChange={event => change({ name: event.target.value })} />
      </div>}
      <div className="settings-field">
        <label htmlFor="connection-url">{builtin ? '内置后端地址' : '远程后端根地址'}</label>
        <input id="connection-url" className="settings-control" type="url" value={draft.url} readOnly={builtin}
          placeholder="https://ssh.example.com" onChange={event => change({ url: event.target.value })} />
        <p className="settings-field-help">{builtin
          ? '地址由内置服务的实际协议和端口决定。修改下方内置设置后，重启内置服务生效。'
          : '不附加 /agent 或 /api/v1/ssh。Nginx 提供 HTTPS 时填写公网域名，不填写内部端口。'}</p>
      </div>
      {!builtin && <div className="settings-field">
        <label htmlFor="connection-trust">证书验证</label>
        <Select id="connection-trust" label="证书验证方式" className="settings-control" value={draft.trust}
          onChange={trust => change({ trust, certificatePem: trust === 'system' ? '' : draft.certificatePem })}
          options={[{ value: 'system', label: '系统信任（正式证书）' },
            ...(isTauriRuntime() ? [{ value: 'certificate' as const, label: '指定服务器自签证书（Windows 桌面）' }] : [])]} />
        <p className="settings-field-help">{draft.trust === 'certificate'
          ? '仅为当前连接指定可信的服务器公开证书，不影响内置后端或系统证书库。'
          : '正式公网证书无需上传任何文件。证书和私钥的部署仍由远程 Java/Nginx 管理。'}</p>
      </div>}
      {!builtin && draft.trust === 'certificate' && <div className="settings-field">
        <label htmlFor="connection-certificate-picker">服务器公开证书</label>
        <input ref={certificateInput} id="connection-certificate-file" type="file" accept=".pem,.crt" hidden
          onChange={async event => {
            const file = event.target.files?.[0]; if (!file) return;
            // 允许修复内容后再次选择同一个文件；取消文件选择不清空现有证书。
            event.currentTarget.value = '';
            setError(''); setMessage(null);
            setResponseDetail(null);
            if (file.size > 16_384) { setError('证书文件不能超过 16 KB。'); return; }
            try {
              const pem = await file.text();
              change({ certificatePem: pem }); setImportedFile({ name: file.name, pem });
            }
            catch { setError('无法读取证书文件。'); }
          }} />
        <button id="connection-certificate-picker" type="button" className="settings-certificate-picker"
          aria-describedby="connection-certificate-hint" onClick={() => certificateInput.current?.click()}>
          <span className="settings-certificate-icon" aria-hidden="true"><Icon name="file" size={23} /></span>
          <span className="settings-certificate-copy">
            <strong title={certificateName}>{certificateName}</strong>
            <span>{hasCertificate ? '内容已载入，请测试连接验证证书' : '单张 PEM 证书 · .pem / .crt · 最大 16 KB'}</span>
          </span>
          <span className="settings-certificate-action"><Icon name="upload" size={15} />{hasCertificate ? '更换文件' : '选择文件'}</span>
        </button>
        <details className="settings-certificate-source">
          <summary><Icon name="down" size={14} /><span>查看或粘贴 PEM 内容</span><Badge tone="neutral">PEM</Badge></summary>
          <label className="settings-certificate-source-label" htmlFor="connection-certificate">公开证书内容</label>
          <textarea id="connection-certificate" className="settings-control settings-control-textarea" rows={5} value={draft.certificatePem}
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            placeholder={'-----BEGIN CERTIFICATE-----\n粘贴完整的公开证书内容\n-----END CERTIFICATE-----'}
            onChange={event => { setImportedFile(null); change({ certificatePem: event.target.value }); }} />
        </details>
        <p id="connection-certificate-hint" className="settings-field-help settings-certificate-hint">
          <Icon name="fingerprint" size={15} />
          <span>请从可信渠道取得公开证书，不导入私钥或证书链。主机名不符、过期仍拒绝；证书变更后需重新导入。</span>
        </p>
      </div>}
    </fieldset>
    <div className="settings-connection-actions">
      <button type="button" className="ghost-button" disabled={busy || !draft.url} aria-busy={testing} onClick={() => void test()}>
        <Icon name={testing ? 'refresh' : 'signal'} size={14} />{testing ? '正在测试…' : '测试连接'}</button>
      {!builtin && <button type="button" className="outlined-button" disabled={busy} onClick={() => void save(false)}>
        {connections.activeId === draft.id ? '保存并使用' : '保存连接'}</button>}
      <button type="button" className="primary-button" disabled={busy || (!builtin && !draft.name.trim())}
        onClick={() => void save(true)}>{busy ? '处理中…' : builtin ? '切回内置后端' : '使用此连接'}</button>
      {!builtin && connections.activeId !== draft.id && connections.profiles.some(profile => profile.id === draft.id)
        && <button type="button" className="ghost-button" disabled={busy} onClick={() => {
          try { deleteBackendConnection(draft.id); setConnections(readBackendConnections());
            select(BUILTIN_BACKEND_ID); setMessage({ title: '远程连接已删除', detail: '当前连接未改变。' }); }
          catch (cause) { setError(String(cause)); }
        }}>删除连接</button>}
    </div>
    <p className="settings-field-help">测试使用上方填写的地址和证书验证方式，无需先保存或应用。
      桌面版独立检查 TLS 和 /api/health，不借用内置证书；业务登录、权限与 WebView 跨域另行验证。</p>
    {testing && <div className="settings-connection-notice" data-accent="blue" role="status">
      <span className="settings-connection-notice-icon" aria-hidden="true"><Icon name="signal" size={20} /></span>
      <div className="settings-connection-notice-copy"><strong>正在检查连接</strong>
        <p>正在验证证书与服务健康状态，不会保存或切换当前连接。</p></div>
    </div>}
    {error && <div className="settings-connection-notice" data-accent="danger" role="alert">
      <span className="settings-connection-notice-icon" aria-hidden="true"><Icon name="alert" size={20} /></span>
      <div className="settings-connection-notice-copy"><strong>操作未完成</strong><p>{error}</p></div>
    </div>}
    {responseDetail && <div className="settings-connection-response" role="region" aria-label="服务器响应正文摘要">
      <p className="settings-field-help">服务器响应正文{responseDetail.httpStatus != null ? `（HTTP ${responseDetail.httpStatus}，摘要）` : '（摘要）'}</p>
      {/* 服务器返回内容不可信；使用 React 文本插值，不能用 dangerouslySetInnerHTML。 */}
      <pre tabIndex={0}>{responseDetail.body}</pre>
    </div>}
    {message && <div className="settings-connection-notice" data-accent={message.latencyMs != null ? 'success' : 'blue'} role="status">
      <span className="settings-connection-notice-icon" aria-hidden="true"><Icon name="check" size={21} /></span>
      <div className="settings-connection-notice-copy"><strong>{message.title}</strong><p>{message.detail}</p></div>
      {message.latencyMs != null && <div className="settings-connection-notice-metrics">
        <Badge tone="success">UP</Badge><span><Icon name="signal" size={13} />{message.latencyMs}<small>ms</small></span>
      </div>}
    </div>}
  </div>;
}

import { useEffect, useState } from 'react';
import { networkApi } from '../api/network';
import type { NetworkSettings as NetworkView, ProxyView, ProxyUpdate, ProxyMode, ProxyProtocol } from '../api/network';
import { notify } from '../state/notifications';
import { Select } from './Select';
import { Icon } from './Ui';

type Draft = ProxyView & { password: string; clearPassword: boolean; bypassText: string };
const rules = (text: string) => [...new Set(text.split(/[\n,;，；]+/).map(value => value.trim()).filter(Boolean))];
const draft = (value: ProxyView): Draft => ({ ...value, host: value.host || '127.0.0.1', port: value.port || 7890, password: '', clearPassword: false, bypassText: (value.bypass ?? []).join('\n') });
const update = ({ passwordConfigured: _, password, bypassText, ...value }: Draft): ProxyUpdate => ({ ...value, bypass: rules(bypassText), ...(password ? { password } : {}) });
function ProxyEditor({ title, scope, value, change, disabled }: { title: string; scope: string; value: Draft; change: (value: Draft) => void; disabled: boolean }) {
  return <fieldset className="network-proxy-editor" disabled={disabled}>
    <legend>{title}</legend>
    <Select<ProxyMode> label={`${title}连接方式`} value={value.mode} disabled={disabled} onChange={mode => change({ ...value, mode })} options={[{ value: 'direct', label: '直接连接' }, { value: 'system', label: '使用本机代理' }, { value: 'custom', label: '自定义代理' }]} />
    <p>{scope}</p>
    {value.mode === 'system' && <small>读取代理环境变量和 Windows 系统静态代理。未配置时直连；PAC 脚本请改用自定义地址。</small>}
    {value.mode === 'custom' && <>
      <div className="network-proxy-address">
        <label>协议<Select<ProxyProtocol> label={`${title}代理协议`} value={value.protocol} disabled={disabled} onChange={protocol => change({ ...value, protocol })} options={[{ value: 'http', label: 'HTTP / CONNECT' }, { value: 'socks5', label: 'SOCKS5' }]} /></label>
        <label>主机<input aria-label={`${title}代理主机`} value={value.host} onChange={event => change({ ...value, host: event.target.value })} placeholder="127.0.0.1" spellCheck={false} /></label>
        <label>端口<input aria-label={`${title}代理端口`} type="number" min={1} max={65535} value={value.port || ''} onChange={event => change({ ...value, port: Number(event.target.value) })} /></label>
      </div>
      <details className="network-proxy-auth"><summary>代理认证（可选）{value.passwordConfigured && <span>密码已保存</span>}</summary>
        <div className="network-proxy-auth-fields"><label>用户名<input aria-label={`${title}代理用户名`} value={value.username} autoComplete="off" onChange={event => change({ ...value, username: event.target.value })} /></label>
          <label>密码<input aria-label={`${title}代理密码`} type="password" autoComplete="new-password" value={value.password} disabled={disabled || value.clearPassword} placeholder={value.passwordConfigured ? '留空保留已保存密码' : '可选'} onChange={event => change({ ...value, password: event.target.value })} /></label></div>
        {value.passwordConfigured && <label className="network-proxy-clear"><input type="checkbox" checked={value.clearPassword} onChange={event => change({ ...value, clearPassword: event.target.checked })} />清除已保存的密码</label>}
      </details>
    </>}
    <div className="network-proxy-bypass">
      <label><span className="network-bypass-heading"><span><Icon name="shield" size={14} />直连白名单</span><small>{rules(value.bypassText).length} 条</small></span>
        <textarea aria-label={`${title}直连白名单`} rows={3} maxLength={65536} value={value.bypassText} spellCheck={false} placeholder={'192.168.1.10\napi.example.com:443\n*.example.com'} onChange={event => change({ ...value, bypassText: event.target.value })} />
      </label>
      <p>每行一条，也可用逗号分隔。省略端口匹配所有端口；命中后直接连接。</p>
      <div className="network-bypass-examples"><code>example.com:443</code><code>*.example.com</code><code>[IPv6]:22</code></div>
      {value.mode === 'direct' && <small>当前全部直连；切换为本机或自定义代理后，白名单生效。</small>}
    </div>
  </fieldset>;
}
export function NetworkSettings() {
  const [value, setValue] = useState<NetworkView | null>(null);
  const [ai, setAi] = useState<Draft | null>(null), [ssh, setSsh] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(true), [failed, setFailed] = useState(false);
  const adopt = (next: NetworkView) => { setValue(next); setAi(draft(next.ai)); setSsh(draft(next.ssh)); };
  useEffect(() => {
    let active = true;
    void networkApi.read().then(next => { if (active) adopt(next); }).catch(error => { if (active) { setFailed(true); notify(error instanceof Error ? error.message : '代理设置读取失败', 'error'); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const refresh = async () => {
    setBusy(true);
    try { const next = await networkApi.read(); setValue(previous => previous ? { ...previous, systemProxy: next.systemProxy } : next); if (!ai || !ssh) adopt(next); setFailed(false); }
    catch (error) { notify(error instanceof Error ? error.message : '代理设置读取失败', 'error'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!ai || !ssh || busy) return;
    setBusy(true);
    try { adopt(await networkApi.save({ ai: update(ai), ssh: update(ssh) })); notify('代理设置已保存，将用于后续模型请求和新建 SSH 连接。', 'success'); }
    catch (error) { notify(error instanceof Error ? error.message : '代理设置保存失败', 'error'); }
    finally { setBusy(false); }
  };
  return <section className="network-settings" aria-label="网络代理">
    <header><strong><Icon name="network" size={16} />网络代理</strong><button type="button" className="outlined-button" disabled={busy} onClick={() => void refresh()}>{failed ? '重新读取' : '刷新本机代理'}</button></header>
    {value && <p className="network-system-status" role="status">本机检测：{value.systemProxy}</p>}
    {ai && ssh && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="network-proxy-grid"><ProxyEditor title="大模型请求" scope="聊天、AI 续写、上下文整理和模型列表。" value={ai} change={setAi} disabled={busy} /><ProxyEditor title="SSH 与文件传输" scope="用于新建 SSH 连接；SFTP 复用相应连接的网络路径。" value={ssh} change={setSsh} disabled={busy} /></div>
      <footer><p>本机 localhost / 127.0.0.1 / ::1 始终直连。已建立的 SSH 连接和正在进行的请求不受影响。代理失败时不会自动改为直连。</p><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存代理设置'}</button></footer>
    </form>}
    {busy && !value && <p>正在读取代理设置…</p>}
  </section>;
}

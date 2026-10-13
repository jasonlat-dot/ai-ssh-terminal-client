import { useEffect, useState } from 'react';
import { modelApi, newModelConfig } from '../api/models';
import type { KeyChange, ModelConfig, ModelProfile } from '../api/models';
import './ModelSettings.css';

export function ModelSettings({ changed, locked = false }: { changed?: () => void; locked?: boolean }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [id, setId] = useState('');
  const [config, setConfig] = useState(newModelConfig);
  const [action, setAction] = useState<KeyChange['action']>('set');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    let active = true;
    void modelApi.list().then(items => { if (active) setProfiles(items); })
      .catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const select = (profile: ModelProfile | null) => {
    setEditing(profile); setId(profile?.id ?? ''); setConfig(profile?.config ?? newModelConfig());
    setKey(''); setAction(profile ? 'keep' : 'set'); setError(''); setNotice(''); setConfirmDelete(false);
  };
  const field = <K extends keyof ModelConfig>(name: K, value: ModelConfig[K]) => setConfig(c => ({ ...c, [name]: value }));
  const reload = async () => {
    setBusy(true);
    try { const items = await modelApi.list(); setProfiles(items); select(items.find(p => p.id === editing?.id) ?? null); }
    catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!id.trim()) throw new Error('请输入配置名称。');
      if (action === 'set' && !key.trim()) throw new Error('请输入新的 API Key。');
      if (editing?.apiKeyConfigured && action === 'keep' && config.baseUrl.trim().replace(/\/+$/, '') !== editing.config.baseUrl.replace(/\/+$/, ''))
        throw new Error('更换 API 地址时，请明确替换或清除原来的 API Key。');
      const saved = await modelApi.save(id.trim(), editing?.revision ?? 0, config, action === 'set' ? { action, value: key } : { action });
      select(saved); setProfiles(items => [...items.filter(p => p.id !== saved.id), saved].sort((a,b) => a.id.localeCompare(b.id)));
      setNotice(saved.ready ? '已保存，可返回终端选择此模型并发送消息。连接将在发送时验证。' : '已保存；需要配置 API Key 后才能对话。');
      changed?.();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!editing) return;
    setBusy(true); setError('');
    try {
      await modelApi.delete(editing.id, editing.revision);
      setProfiles(items => items.filter(p => p.id !== editing.id)); select(null);
      setNotice('配置已删除，已有会话仍保留在本地数据库。'); changed?.();
    } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
    finally { setBusy(false); }
  };
  return <section className="model-settings rust-config-card" aria-label="模型设置">
    <h2>模型设置</h2><p>支持 OpenAI 兼容 Chat Completions。当前提供文本对话，工具执行和聊天附件将在后续接入。</p>
    {error && <p className="settings-error" role="alert">{error}<button type="button" disabled={busy || locked} onClick={() => void reload()}>重新加载配置</button></p>}
    {notice && <p className="rust-settings-notice" role="status">{notice}</p>}
    {locked && <p role="status">请等待当前回复结束或停止生成后再修改模型。</p>}
    <fieldset disabled={busy || locked}>
      <div className="model-list">{profiles.map(p => <button type="button" key={p.id} aria-pressed={editing?.id === p.id} onClick={() => select(p)}>{p.id} · {p.ready ? '已配置' : '缺少密钥'}</button>)}<button type="button" onClick={() => select(null)}>＋ 新建配置</button></div>
      <div className="rust-fields">
        <label>配置名称<input value={id} disabled={!!editing} maxLength={64} onChange={e => setId(e.target.value)} placeholder="例如：日常问答" /></label>
        <label>模型 ID<input value={config.model} onChange={e => field('model', e.target.value)} placeholder="填写供应商提供的模型 ID" /></label>
        <label>API 基础地址<input value={config.baseUrl} onChange={e => field('baseUrl', e.target.value)} placeholder="https://api.example.com/v1/" /><small>包含 /v1 或代理前缀，不能包含密钥。</small></label>
        <label>接口相对路径<input value={config.completionsPath} onChange={e => field('completionsPath', e.target.value)} /><small>与基础地址拼接，避免重复 /v1。</small></label>
      </div>
      <label className="rust-checkbox"><input type="checkbox" checked={config.requireApiKey} onChange={e => field('requireApiKey', e.target.checked)} />此服务需要 API Key</label>
      <div className="rust-fields">
        <label>API Key（{editing?.apiKeyConfigured ? '已保存，不回显' : '尚未保存'}）<select value={action} onChange={e => { setAction(e.target.value as KeyChange['action']); setKey(''); }}><option value="keep">保留现有密钥</option><option value="set">设置 / 替换密钥</option><option value="clear">清除密钥</option></select></label>
        {action === 'set' && <label>新 API Key<input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} /><small>保存后加密存储于本机，不返回到界面。</small></label>}
        <label>上下文窗口（tokens）<input type="number" min={256} max={16777216} value={config.contextWindow} onChange={e => field('contextWindow', Number(e.target.value))} /><small>请按供应商说明填写；8192 是保守初值。</small></label>
        <label>最大输出（tokens）<input type="number" min={1} value={config.outputReserve} onChange={e => field('outputReserve', Number(e.target.value))} /></label>
      </div>
      <details><summary>高级参数</summary><div className="rust-fields">
        <label>安全预留（tokens）<input type="number" min={0} value={config.safetyReserve} onChange={e => field('safetyReserve', Number(e.target.value))} /></label>
        <label>请求超时（秒）<input type="number" min={1} max={600} value={config.timeoutSeconds} onChange={e => field('timeoutSeconds', Number(e.target.value))} /></label>
        <label>最大响应（bytes）<input type="number" min={1024} max={8388608} value={config.maxResponseBytes} onChange={e => field('maxResponseBytes', Number(e.target.value))} /></label>
        <label>输出参数<select value={config.outputTokenParameter} onChange={e => field('outputTokenParameter', e.target.value as ModelConfig['outputTokenParameter'])}><option value="maxCompletionTokens">max_completion_tokens</option><option value="maxTokens">max_tokens（旧兼容服务）</option></select></label>
        <label>Temperature（留空则不发送）<input type="number" min={0} max={2} step="0.1" value={config.temperature ?? ''} onChange={e => { field('temperature', e.target.value === '' ? null : Number(e.target.value)); field('capabilities', { ...config.capabilities, temperature: e.target.value !== '' }); }} /></label>
        <label>Reasoning effort<select value={config.reasoningEffort ?? ''} onChange={e => { field('reasoningEffort', (e.target.value || null) as ModelConfig['reasoningEffort']); field('capabilities', { ...config.capabilities, reasoningEffort: !!e.target.value }); }}><option value="">不发送</option>{['none','minimal','low','medium','high','xhigh'].map(v => <option key={v} value={v}>{v}</option>)}</select><small>只有供应商明确支持时才设置这些参数。</small></label>
      </div></details>
      <div className="rust-service-actions"><button className="primary-button" type="button" onClick={() => void save()}>保存模型</button>
        {editing && (confirmDelete ? <><span>删除“{editing.id}”？</span><button type="button" onClick={() => void remove()}>确认删除</button><button type="button" onClick={() => setConfirmDelete(false)}>取消</button></> : <button type="button" onClick={() => setConfirmDelete(true)}>删除配置</button>)}
      </div>
    </fieldset>
  </section>;
}

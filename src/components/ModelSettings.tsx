import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { modelApi, newModelConfig } from '../api/models';
import type { KeyChange, ModelConfig, ModelProfile } from '../api/models';
import { AccentIcon, Badge, Icon, Toggle } from './Ui';
import type { AccentTone, IconName } from './Ui';
import { Select } from './Select';
import './ModelSettings.css';

function ModelField({ id, label, hint, children, wide = false, badge, icon, tone = 'blue' }: { id:string; label:string; hint?:string; children:ReactNode; wide?:boolean; badge?:string; icon?:IconName; tone?:AccentTone }) {
  return <div className={`settings-field ${wide ? 'is-wide' : ''}`}>
    <div className="settings-field-head"><label htmlFor={id}>{label}</label>{badge && <Badge tone={tone} icon={icon} className="model-field-badge">{badge}</Badge>}</div>
    {children}{hint && <p className="settings-field-help">{hint}</p>}
  </div>;
}

export function ModelSettings({ changed, locked = false }: { changed?: () => void; locked?: boolean }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState(newModelConfig);
  const [action, setAction] = useState<KeyChange['action']>('set');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    let active = true;
    void modelApi.list().then(items => { if (active) { setProfiles(items); if (items[0]) select(items[0]); } })
      .catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const select = (profile: ModelProfile | null) => {
    setEditing(profile); setDisplayName(profile?.displayName ?? profile?.id ?? ''); setConfig(profile?.config ?? newModelConfig());
    setKey(''); setAction(profile ? 'keep' : 'set'); setError(''); setNotice(''); setConfirmDelete(false); setAdvanced(false);
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
      if (!displayName.trim()) throw new Error('请输入配置名称。');
      if (action === 'set' && !key.trim()) throw new Error('请输入新的 API Key。');
      if (editing?.apiKeyConfigured && action === 'keep' && config.baseUrl.trim().replace(/\/+$/, '') !== editing.config.baseUrl.replace(/\/+$/, ''))
        throw new Error('更换 API 地址时，请明确替换或清除原来的 API Key。');
      const saved = await modelApi.save(editing?.id ?? crypto.randomUUID(), editing?.revision ?? 0, config, action === 'set' ? { action, value: key } : { action }, displayName.trim());
      select(saved); setProfiles(items => [...items.filter(p => p.id !== saved.id), saved].sort((a,b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id)));
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
  const disabled = busy || locked;
  return <section className="model-settings" aria-label="模型设置">
    <div className="model-workspace">
      <aside className="model-profiles" aria-label="模型配置列表">
        <div className="model-profiles-heading"><strong>我的模型</strong><span>{profiles.length}</span></div>
        <button type="button" className="model-create" disabled={disabled} onClick={() => select(null)}><Icon name="plus" size={15}/>新建配置</button>
        <div className="model-profile-items">
          {busy && !profiles.length ? <div className="model-loading" role="status"><i/><i/><i/><span>正在读取配置…</span></div> : profiles.length ? profiles.map(p => <button type="button" className={`model-profile ${editing?.id === p.id ? 'selected' : ''}`} key={p.id} aria-pressed={editing?.id === p.id} disabled={disabled} onClick={() => select(p)}>
            <span className="model-profile-icon"><Icon name="bot" size={18}/></span><span className="model-profile-info"><strong>{p.displayName ?? p.id}</strong><small>{p.config.model}</small><span className={`model-profile-state ${p.ready ? 'ready' : ''}`}><i/>{p.ready ? '已配置' : '需要密钥'}</span></span><Icon name="right" size={14}/>
          </button>) : <div className="model-list-empty"><Icon name="bot" size={26}/><strong>添加第一个模型</strong><p>填写连接信息后，即可开始对话。</p></div>}
        </div>
        <p className="model-profile-note"><Icon name="key" size={14}/>密钥加密保存在本机</p>
      </aside>
      <form className="model-editor" onSubmit={e => { e.preventDefault(); if (!disabled) void save(); }}>
        <div className="model-editor-scroll">
          {error && <div className="model-feedback error" role="alert"><Icon name="alert" size={16}/><span>{error}</span><button type="button" disabled={disabled} onClick={() => void reload()}>重新加载</button></div>}
          {notice && <div className="model-feedback success" role="status"><Icon name="check" size={16}/><span>{notice}</span></div>}
          {locked && <div className="model-feedback" role="status"><Icon name="history" size={16}/><span>请等待回复结束或停止生成后再修改模型。</span></div>}
          <fieldset disabled={disabled}>
            <div className="model-form-columns"><div className="model-form-column">
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="network" tone="blue" size={17}/><h4>模型渠道</h4><Badge tone="violet" icon="bot">模型</Badge></div>
              <div className="model-protocol-card"><div className="model-protocol-heading"><AccentIcon icon="network" tone="blue"/><div><strong>接口协议</strong><p>使用 OpenAI 兼容 Chat Completions。</p></div></div><div className="model-protocol-selected" aria-label="当前接口协议：OpenAI 兼容"><span><strong>OpenAI 兼容</strong><small>已选择</small></span><Icon name="check" size={16}/></div></div>
              <div className="settings-fields-grid">
                <ModelField id="model-name" label="配置名称" badge="PROFILE" icon="edit" tone="neutral"><input id="model-name" className="settings-control" value={displayName} maxLength={64} onChange={e => setDisplayName(e.target.value)} placeholder="例如：日常问答" /></ModelField>
                <ModelField id="model-id" label="模型 ID" badge="MODEL" icon="bot" tone="violet"><input id="model-id" className="settings-control settings-control-mono" value={config.model} onChange={e => field('model', e.target.value)} placeholder="供应商提供的模型 ID" /></ModelField>
                <ModelField id="model-url" label="API 基础地址" wide badge="BASE URL" icon="network" tone="cyan" hint="包含 /v1 或代理前缀，不要包含密钥。"><input id="model-url" className="settings-control settings-control-mono" value={config.baseUrl} onChange={e => field('baseUrl', e.target.value)} placeholder="https://api.example.com/v1/" /></ModelField>
              </div>
            </section>
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="key" tone="amber" size={17}/><h4>身份认证</h4><Badge tone="amber" icon="shield">敏感</Badge></div>
              <div className="model-auth-toggle"><div><strong>使用 API Key</strong><p>无认证的本地模型服务可以关闭。</p></div><Toggle label="此服务需要 API Key" value={config.requireApiKey} disabled={disabled} onChange={value => { field('requireApiKey', value); if (!editing && !value) { setAction('clear'); setKey(''); } }}/></div>
              <div className="settings-fields-grid">
                <ModelField id="model-key-action" label="密钥操作"><Select id="model-key-action" label="密钥操作" className="settings-control" value={action} disabled={disabled} options={[{value:'keep',label:'保留现有密钥'},{value:'set',label:'设置 / 替换密钥'},{value:'clear',label:'清除密钥'}]} onChange={value => {setAction(value);setKey('');}} /></ModelField>
                {action === 'set' ? <ModelField id="model-api-key" label="新 API Key" badge="敏感" icon="shield" tone="amber"><input id="model-api-key" className="settings-control settings-control-mono" type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder="输入 API Key" /></ModelField> : <div className="model-key-summary"><AccentIcon icon="key" tone={editing?.apiKeyConfigured ? 'success' : 'neutral'} size={16}/><div><strong>{editing?.apiKeyConfigured ? '密钥已保存' : '尚未保存密钥'}</strong><small>{action === 'clear' ? '保存时清除密钥' : '加密保存，不回显原文'}</small></div></div>}
              </div><p className="model-field-note">已保存的密钥不会回显。更换 API 地址时，需要替换或清除密钥。</p>
            </section>
            </div><div className="model-form-column">
            <section className="model-form-section"><div className="model-section-title"><AccentIcon icon="signal" tone="violet" size={17}/><h4>接口与生成</h4><Badge tone="violet" icon="settings">参数</Badge></div><div className="settings-fields-grid">
              <ModelField id="model-path" label="接口相对路径" hint="与基础地址拼接，避免重复 /v1。"><input id="model-path" className="settings-control settings-control-mono" value={config.completionsPath} onChange={e => field('completionsPath', e.target.value)} /></ModelField>
              <ModelField id="model-token-param" label="输出参数"><Select id="model-token-param" label="输出参数" className="settings-control" value={config.outputTokenParameter} disabled={disabled} options={[{value:'maxCompletionTokens',label:'max_completion_tokens'},{value:'maxTokens',label:'max_tokens'}]} onChange={value => field('outputTokenParameter', value)}/></ModelField>
              <ModelField id="model-window" label="上下文窗口" badge="TOKENS" tone="blue" hint="按供应商说明填写"><input id="model-window" className="settings-control" type="number" min={256} max={16777216} value={config.contextWindow} onChange={e => field('contextWindow', Number(e.target.value))} /></ModelField>
              <ModelField id="model-output" label="最大输出" badge="TOKENS" tone="blue" hint="为本次回复预留"><input id="model-output" className="settings-control" type="number" min={1} value={config.outputReserve} onChange={e => field('outputReserve', Number(e.target.value))} /></ModelField>
              <ModelField id="model-timeout" label="请求超时（秒）"><input id="model-timeout" className="settings-control" type="number" min={1} max={600} value={config.timeoutSeconds} onChange={e => field('timeoutSeconds', Number(e.target.value))} /></ModelField>
              <ModelField id="model-response" label="最大响应（bytes）"><input id="model-response" className="settings-control" type="number" min={1024} max={8388608} value={config.maxResponseBytes} onChange={e => field('maxResponseBytes', Number(e.target.value))} /></ModelField>
            </div></section>
            <section className={`model-form-section model-advanced ${advanced ? 'open' : ''}`}><button type="button" className="model-advanced-toggle" aria-expanded={advanced} aria-controls="model-advanced-fields" onClick={() => setAdvanced(value => !value)}><Icon name="settings" size={16}/><span><strong>高级参数</strong><small>请求限制与供应商兼容选项</small></span><Icon name={advanced ? 'up' : 'down'} size={15}/></button>
              {advanced && <div id="model-advanced-fields" className="settings-fields-grid">
                <ModelField id="model-safety" label="安全预留（tokens）"><input id="model-safety" className="settings-control" type="number" min={0} value={config.safetyReserve} onChange={e => field('safetyReserve', Number(e.target.value))} /></ModelField>
                <ModelField id="model-compact" label="自动整理触发比例" badge="%" tone="blue" hint="接近此比例时整理较早对话，原始历史仍会保留。"><input id="model-compact" className="settings-control" type="number" min={1} max={99} value={config.compactPercent} onChange={e => field('compactPercent', Number(e.target.value))} /></ModelField>
                <ModelField id="model-temperature" label="Temperature" hint="留空则不发送"><input id="model-temperature" className="settings-control" type="number" min={0} max={2} step="0.1" value={config.temperature ?? ''} onChange={e => { field('temperature', e.target.value === '' ? null : Number(e.target.value)); field('capabilities', { ...config.capabilities, temperature: e.target.value !== '' }); }} /></ModelField>
                <ModelField id="model-reasoning" label="推理强度" wide badge="REASONING" icon="bulb" tone="amber" hint="仅在供应商明确支持时设置；默认不发送此参数。">
                  <Select id="model-reasoning" label="Reasoning effort" className="settings-control" value={config.reasoningEffort ?? ''} disabled={disabled} options={[{value:'',label:'不发送（默认）'},...(['none','minimal','low','medium','high','xhigh'] as const).map(value => ({value,label:value}))]} onChange={value => { field('reasoningEffort', (value || null) as ModelConfig['reasoningEffort']); field('capabilities', { ...config.capabilities, reasoningEffort: !!value }); }}/>
                  <div className="model-reasoning-presets" aria-label="推理强度快捷选项">{([{value:'none',label:'关闭'},{value:'minimal',label:'极低'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'},{value:'xhigh',label:'很高'}] as const).map(option => <button type="button" key={option.value} disabled={disabled} aria-pressed={config.reasoningEffort === option.value} onClick={() => {field('reasoningEffort', option.value);field('capabilities',{...config.capabilities,reasoningEffort:true});}}><span><strong>{option.label}</strong><small>{option.value}</small></span>{config.reasoningEffort === option.value && <Icon name="check" size={13}/>}</button>)}</div>
                </ModelField>
              </div>}
            </section>
            </div></div>
          </fieldset>
        </div>
        <footer className="model-editor-footer">
          {confirmDelete && editing ? <div className="model-delete-confirm" role="alert"><span>删除“{editing.displayName ?? editing.id}”？历史会话会保留。</span><button type="button" className="model-danger-button" disabled={disabled} onClick={() => void remove()}>确认删除</button><button type="button" className="model-secondary-button" onClick={() => setConfirmDelete(false)}>取消</button></div> : <>
            {editing && <button type="button" className="model-delete-button" disabled={disabled} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={15}/>删除</button>}
            <span className="model-save-hint">保存后用于后续对话</span><button className="model-save-button" type="submit" disabled={disabled}><Icon name={busy ? 'refresh' : 'check'} size={16}/>{busy ? '处理中…' : '保存配置'}</button>
          </>}
        </footer>
      </form>
    </div>
  </section>;
}

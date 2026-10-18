import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { defaultExecutionLimits, extensionApi, type ExecutionLimits, type ExtensionSettings } from '../api/agentExtensions';
import { Select } from './Select';
import { Modal, Icon, IconHeading } from './Ui';
import { JsonCodeEditor } from './JsonCodeEditor';
import { formatMcpConfig, parseMcpConfig, validateSavedMcpValues, mcpExamples } from '../state/mcpConfig';
import { maxSkillDirectories, parseSkillDirectories } from '../state/skillDirectories';
import { notify } from '../state/notifications';
import './ModelNumberInput.css';
import './AgentExtensionSettings.css';

type LimitDraft = Record<keyof ExecutionLimits, string>;
const limitRules = {
  modelRounds: ['主对话模型请求轮数', 2, 256],
  toolCalls: ['主对话工具调用次数', 1, 1024],
  childModelRounds: ['子任务模型请求轮数', 2, 256],
  childToolCalls: ['子任务工具调用次数', 1, 1024],
  maxChildTasks: ['最多子任务数量', 1, 16],
} as const;
const roundPresets = [8, 16, 24, 32, 48, 64, 128, 256];
const callPresets = [16, 32, 64, 128, 256, 512, 1024];
const childPresets = [1, 2, 3, 4, 6, 8, 12, 16];
const draftLimits = (limits: ExecutionLimits): LimitDraft => Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, String(value)])) as LimitDraft;
export function parseExecutionLimits(draft: LimitDraft): ExecutionLimits {
  const values = {} as ExecutionLimits;
  for (const key of Object.keys(limitRules) as (keyof ExecutionLimits)[]) {
    const [label, min, max] = limitRules[key];
    const value = Number(draft[key]);
    if (!draft[key].trim() || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}请输入 ${min}–${max} 之间的整数。`);
    values[key] = value;
  }
  return values;
}

export function AgentExtensionSettings({ locked = false }: { locked?: boolean }) {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<ExtensionSettings | null>(null);
  const [limits, setLimits] = useState<LimitDraft>(() => draftLimits(defaultExecutionLimits));
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [mcpDraft, setMcpDraft] = useState(() => formatMcpConfig([]));
  const [mcpError, setMcpError] = useState('');
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillRows, setSkillRows] = useState<string[]>(['']);
  const [skillsError, setSkillsError] = useState('');
  const dialogOpen = mcpOpen || skillsOpen;
  const accept = (value: ExtensionSettings) => {
    const executionLimits = { ...defaultExecutionLimits, ...value.config.executionLimits };
    setSettings({ ...value, config: { ...value.config, executionLimits } });
    setSavedSettings({ ...value, config: { ...value.config, executionLimits } });
    setLimits(draftLimits(executionLimits));
    setMcpDraft(formatMcpConfig(value.config.servers));
    setMcpError('');
  };
  const load = () => {
    setBusy(true); setError('');
    void extensionApi.settings().then(accept).catch(e => setError(String(e))).finally(() => setBusy(false));
  };
  useEffect(() => {
    let alive = true;
    void extensionApi.settings().then(value => { if (alive) accept(value); }).catch(e => { if (alive) setError(String(e)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, []);
  const change = (patch: Partial<ExtensionSettings['config']>) => {
    setSettings(value => value ? { ...value, config: { ...value.config, ...patch } } : value);
  };
  const updateMcp = (value: string) => { setMcpDraft(value); setMcpError(''); };
  const closeMcp = () => {
    if (busy) return;
    setMcpOpen(false); setMcpError(''); setMcpDraft(formatMcpConfig(settings?.config.servers ?? []));
  };
  const closeSkills = () => {
    if (busy) return;
    setSkillsOpen(false); setSkillsError(''); setSkillRows(settings?.config.skillRoots.length ? [...settings.config.skillRoots] : ['']);
  };
  const changeSkillRow = (index: number, value: string) => {
    setSkillRows(rows => rows.map((row, i) => i === index ? value : row)); setSkillsError('');
  };
  const formatMcp = () => {
    try { parseMcpConfig(mcpDraft); updateMcp(JSON.stringify(JSON.parse(mcpDraft), null, 2)); }
    catch (cause) { setMcpError((cause as Error).message); }
  };
  const addExample = (kind: keyof typeof mcpExamples) => {
    try {
      parseMcpConfig(mcpDraft);
      const root = JSON.parse(mcpDraft) as { mcpServers: Record<string, unknown> };
      if (Object.keys(root.mcpServers).length >= 8) throw new Error('最多配置 8 个服务。');
      const base = kind === 'streamableHttp' ? 'aisearch-mcp-server' : kind === 'sse' ? 'AISearch' : 'filesystem';
      let name = base; let index = 2;
      while (Object.prototype.hasOwnProperty.call(root.mcpServers, name)) name = `${base}-${index++}`;
      root.mcpServers[name] = mcpExamples[kind];
      updateMcp(JSON.stringify(root, null, 2));
    } catch (cause) { setMcpError((cause as Error).message); }
  };
  const save = async () => {
    if (!settings || !savedSettings || busy || locked || dialogOpen) return;
    setError('');
    let executionLimits: ExecutionLimits;
    try {
      executionLimits = parseExecutionLimits(limits);
    } catch (cause) { setError((cause as Error).message); return; }
    setBusy(true);
    try {
      accept(await extensionApi.save({ ...savedSettings, revision: settings.revision, config: { ...savedSettings.config, executionLimits, subAgents: settings.config.subAgents } }, 'execution'));
      notify('执行额度与子任务设置已保存，下次发送消息时生效。', 'success');
    }
    catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const saveMcp = async () => {
    if (!settings || !savedSettings || busy || locked || !mcpOpen) return;
    setMcpError('');
    let servers: ExtensionSettings['config']['servers'];
    try { servers = parseMcpConfig(mcpDraft); validateSavedMcpValues(servers, settings.config.servers); }
    catch (cause) { setMcpError((cause as Error).message); return; }
    setBusy(true);
    try {
      const result = await extensionApi.save({ ...savedSettings, revision: settings.revision, config: { ...savedSettings.config, servers } }, 'mcp');
      setSavedSettings(result);
      setSettings(current => current ? { ...result, config: { ...result.config, subAgents: current.config.subAgents } } : result);
      setMcpDraft(formatMcpConfig(result.config.servers)); setMcpOpen(false); notify('MCP 配置已保存，下次发送消息时生效。', 'success');
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setMcpError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const saveSkills = async () => {
    if (!settings || !savedSettings || busy || locked || !skillsOpen) return;
    setSkillsError('');
    let skillRoots: string[];
    try { skillRoots = parseSkillDirectories(skillRows); }
    catch (cause) { setSkillsError((cause as Error).message); return; }
    setBusy(true);
    try {
      const result = await extensionApi.save({ ...savedSettings, revision: settings.revision, config: { ...savedSettings.config, skillRoots } }, 'skills');
      setSavedSettings(result);
      setSettings(current => current ? { ...result, config: { ...result.config, subAgents: current.config.subAgents } } : result);
      setSkillsOpen(false); setSkillRows(result.config.skillRoots.length ? [...result.config.skillRoots] : ['']); notify('Skills 目录已保存，下次发送消息时生效。', 'success');
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setSkillsError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const limitInput = (key: keyof ExecutionLimits, label: string) => {
    const presets = key === 'maxChildTasks' ? childPresets : key === 'modelRounds' || key === 'childModelRounds' ? roundPresets : callPresets;
    const unit = key === 'maxChildTasks' ? '个' : key === 'modelRounds' || key === 'childModelRounds' ? '轮' : '次';
    const selected = presets.find(value => String(value) === limits[key]);
    const options = presets.map(value => ({ value: String(value), label: `${value} ${unit}`, description: value === defaultExecutionLimits[key] ? '推荐' : undefined }));
    if (selected === undefined) options.unshift({ value: limits[key], label: '自定义', description: limits[key] || '尚未填写' });
    const update = (value: string) => { setLimits(current => ({ ...current, [key]: value })); };
    const id = `extension-limit-${key}`;
    return <div className="extension-limit-field"><label htmlFor={id}>{label}</label>
      <div className={`model-token-input extension-limit-control${busy || locked ? ' is-disabled' : ''}`}>
        <input id={id} type="number" className="model-token-value" aria-label={limitRules[key][0]} min={limitRules[key][1]} max={limitRules[key][2]} step={1} value={limits[key]} disabled={busy || locked} onChange={event => update(event.target.value)} />
        <Select id={`${id}-preset`} label={`${limitRules[key][0]}常用档位`} className="model-token-presets" value={limits[key]} displayValue={selected === undefined ? '自定义' : `${selected} ${unit}`} options={options} menuMinWidth={180} menuAlign="end" menuClassName="model-token-menu" disabled={busy || locked} onChange={update} />
      </div>
    </div>;
  };
  return <div className="agent-extension-settings">
    <header className="extension-heading"><IconHeading as="h2" icon="extensions" tone="blue">工具与 Skills</IconHeading><p>管理执行额度与扩展工具，沿用当前对话的审批边界。</p></header>
    {error && <div className="extension-feedback settings-error" role="alert"><span>{error}</span><button type="button" onClick={load} disabled={busy}>重新读取</button></div>}
    {!settings && busy && <p role="status">正在读取工具设置…</p>}
    {settings && <form inert={dialogOpen} onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || locked || dialogOpen} className="extension-form-fields">
        <section className="extension-section extension-budget-section" aria-labelledby="extension-budget-title">
          <div className="extension-section-heading"><div><IconHeading id="extension-budget-title" icon="settings" tone="blue">执行额度</IconHeading><p>每次发送消息重新计数；主对话与子任务独立。可选常用档位或直接输入。</p></div><button type="button" onClick={() => { setLimits(draftLimits(defaultExecutionLimits)); notify('已恢复推荐值，点击保存设置后生效。'); }}>恢复推荐值</button></div>
          <div className="extension-budget-columns">
            <div className="extension-budget-group"><IconHeading as="h4" icon="chat" tone="blue">主对话</IconHeading>{limitInput('modelRounds', '模型请求轮数')}{limitInput('toolCalls', '工具调用次数')}</div>
            <div className="extension-budget-group"><IconHeading as="h4" icon="network" tone="violet">每个子任务</IconHeading>{limitInput('childModelRounds', '模型请求轮数')}{limitInput('childToolCalls', '工具调用次数')}</div>
          </div>
          <p className="extension-budget-note">输出回查（512 字节/页）不占工具调用次数，仍计入模型轮数；最后一轮用于报告，上下文容量另有限制。</p>
        </section>
        <section className="extension-section" aria-labelledby="extension-children-title">
          <div className="extension-section-heading"><div><IconHeading id="extension-children-title" icon="bot" tone="violet">子 Agent</IconHeading><p>继承父任务的模型、服务器目标与审批边界。</p></div><label className="extension-check"><input type="checkbox" checked={settings.config.subAgents} onChange={event => change({ subAgents: event.target.checked })} />允许委派</label></div>
          <div className="extension-child-limit">{limitInput('maxChildTasks', '每次处理最多子任务')}</div><p>限制累计派发数；并发由宿主调度，停止对话会停止子任务。</p>
        </section>
        <section className="extension-section" aria-labelledby="extension-skills-title">
          <div className="extension-section-heading"><div><IconHeading id="extension-skills-title" icon="book" tone="amber">Skills</IconHeading><p>{settings.config.skillRoots.length ? `已配置 ${settings.config.skillRoots.length} 个技能目录` : '尚未配置技能目录'}</p></div><button type="button" aria-haspopup="dialog" onClick={() => { setSkillRows(settings.config.skillRoots.length ? [...settings.config.skillRoots] : ['']); setSkillsError(''); setSkillsOpen(true); }}><Icon name="settings" size={14} />配置 Skills</button></div>
          <p>按需读取 SKILL.md 和参考文件，不自动运行脚本。</p>
        </section>
        <section className="extension-section extension-mcp-section" aria-labelledby="extension-mcp-title">
          <div className="extension-section-heading"><div><IconHeading id="extension-mcp-title" icon="extensions" tone="cyan">MCP 服务</IconHeading><p>{settings.config.servers.length ? `已配置 ${settings.config.servers.length} 个服务 · ${settings.config.servers.filter(server => server.enabled).length} 个启用` : '添加 HTTP、SSE 或本机 stdio 服务，供普通对话与服务器对话使用。'}</p></div><button type="button" aria-haspopup="dialog" onClick={() => { setMcpDraft(formatMcpConfig(settings.config.servers)); setMcpError(''); setMcpOpen(true); }}><Icon name="settings" size={14} />配置 MCP</button></div>
          {!!settings.config.servers.length && <p className="extension-mcp-summary">{settings.config.servers.slice(0, 4).map(server => server.name).join('、')}{settings.config.servers.length > 4 ? ` 等 ${settings.config.servers.length} 个服务` : ''}</p>}
        </section>
      </fieldset>
      <footer className="extension-save">{locked && <span>对话生成期间暂不可修改设置。</span>}<button type="submit" className="primary" title="只保存执行额度与子任务设置；MCP、Skills 在各自弹窗保存" disabled={busy || locked || dialogOpen}>{busy ? '保存中…' : '保存设置'}</button></footer>
    </form>}
    {mcpOpen && settings && createPortal(<Modal icon="extensions" iconTone="cyan" title="配置 MCP 服务" className="mcp-config-dialog" onClose={closeMcp} dismissDisabled={busy}>
      <form className="mcp-config-form" onSubmit={event => { event.preventDefault(); void saveMcp(); }} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void saveMcp(); }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); if (!busy && !locked) formatMcp(); }
      }}>
        <fieldset disabled={busy || locked} className="mcp-config-fields">
          <div className="mcp-config-toolbar"><span className="mcp-config-language">JSON</span><div className="mcp-config-example-actions"><span>插入示例</span>{(['streamableHttp', 'sse', 'stdio'] as const).map(kind => <button type="button" key={kind} onClick={() => addExample(kind)}>{kind === 'streamableHttp' ? 'HTTP' : kind === 'sse' ? 'SSE' : 'stdio'}</button>)}</div><button type="button" onClick={formatMcp} title="Ctrl+Shift+F">格式化 JSON</button></div>
          <p className="mcp-config-intro" id="mcp-json-help">把多个服务放进同一个 mcpServers 对象，最多 8 个。插入的示例默认停用，修改后设 enabled: true。</p>
          <div className="mcp-config-editor"><JsonCodeEditor id="mcp-json-config" label="MCP JSON 配置" describedBy="mcp-json-help" value={mcpDraft} onChange={updateMcp} disabled={busy || locked} invalid={!!mcpError} /></div>
        </fieldset>
        {mcpError && <p className="mcp-config-error" role="alert">{mcpError}</p>}
        <details className="mcp-config-help"><summary>配置格式与已保存凭据</summary><p>HTTP 支持 url / baseUrl、headers 和 description；stdio 使用 command、args 和 env 对象。headers 与 env 的值加密保存，__SHELLPILOT_SAVED__ 表示沿用已保存值，替换可更新、删除字段可清除。更改服务名或目标须重新填写凭据。SSE 地址中的 Key 随 URL 保存在本地。</p></details>
        <footer className="mcp-config-footer"><span>{locked ? '对话生成期间暂不可修改配置。' : '保存后下次发送消息生效 · Ctrl+Enter 保存'}</span><button type="button" disabled={busy} onClick={closeMcp}>取消</button><button type="submit" className="primary" disabled={busy || locked}>{busy ? '保存中…' : '保存配置'}</button></footer>
      </form>
    </Modal>, document.body)}
    {skillsOpen && settings && createPortal(<Modal icon="book" iconTone="amber" title="配置 Skills 目录" className="skills-config-dialog" onClose={closeSkills} dismissDisabled={busy}>
      <form className="mcp-config-form skills-config-form" onSubmit={event => { event.preventDefault(); void saveSkills(); }} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void saveSkills(); }
      }}>
        <fieldset disabled={busy || locked} className="mcp-config-fields skills-config-fields">
          <div className="mcp-config-toolbar"><p className="mcp-config-intro" id="skills-directory-help">每行一个本机绝对目录，可粘贴多行，最多 16 个。</p><button type="button" disabled={skillRows.length >= maxSkillDirectories} onClick={() => { setSkillRows(rows => [...rows, '']); setSkillsError(''); }}><Icon name="plus" size={14} />添加目录</button></div>
          <div className="skills-directory-list" aria-label="Skills 目录列表">
            {skillRows.map((path, index) => <div className="skills-directory-row" data-invalid={skillsError.startsWith(`第 ${index + 1} 个目录`) || undefined} key={index}>
              <span className="skills-directory-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><Icon name="folder" size={16} />
              <input aria-label={`技能目录 ${index + 1}`} aria-describedby={skillsError ? 'skills-directory-help skills-directory-error' : 'skills-directory-help'} aria-invalid={skillsError.startsWith(`第 ${index + 1} 个目录`)} data-autofocus={index === 0 || undefined} value={path} spellCheck={false} autoComplete="off" placeholder={'例如 C:\\Users\\你的用户名\\.agents\\skills'} onChange={event => changeSkillRow(index, event.target.value)} onPaste={event => {
                const text = event.clipboardData.getData('text');
                if (!/[\r\n]/.test(text)) return;
                event.preventDefault();
                const pasted = text.split(/\r\n|\r|\n/).map(value => value.trim()).filter(Boolean);
                if (!pasted.length) return;
                if (skillRows.length - 1 + pasted.length > maxSkillDirectories) { setSkillsError('最多配置 16 个 Skills 目录。'); return; }
                setSkillRows(rows => [...rows.slice(0, index), ...pasted, ...rows.slice(index + 1)]); setSkillsError('');
              }} />
              <button type="button" className="skills-directory-remove" aria-label={`移除技能目录 ${index + 1}`} title="移除目录" onClick={() => { setSkillRows(rows => rows.length > 1 ? rows.filter((_, i) => i !== index) : ['']); setSkillsError(''); }}><Icon name="trash" size={15} /></button>
            </div>)}
          </div>
          <p className="mcp-config-intro">只配置技能目录，不自动执行脚本或授予工具权限。留空并保存可清除目录配置。</p>
        </fieldset>
        {skillsError && <p id="skills-directory-error" className="mcp-config-error" role="alert">{skillsError}</p>}
        <footer className="mcp-config-footer"><span>{locked ? '对话生成期间暂不可修改配置。' : '保存后下次发送消息生效 · Ctrl+Enter 保存'}</span><button type="button" disabled={busy} onClick={closeSkills}>取消</button><button type="submit" className="primary" disabled={busy || locked}>{busy ? '保存中…' : '保存目录'}</button></footer>
      </form>
    </Modal>, document.body)}
  </div>;
}

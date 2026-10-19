import { useEffect, useRef, useState } from 'react';
import { modelApi, type ModelConfig, type ModelProfile } from '../api/models';
import { modelProtocols } from '../api/modelProtocols';
import { notify } from '../state/notifications';
import { Select } from './Select';
import { Icon } from './Ui';

const options = [
  { value: '', label: '默认', description: '不发送推理强度参数' },
  { value: 'none', label: '关闭', description: 'none' },
  { value: 'minimal', label: '极低', description: 'minimal' },
  { value: 'low', label: '低', description: 'low' },
  { value: 'medium', label: '中', description: 'medium' },
  { value: 'high', label: '高', description: 'high' },
  { value: 'xhigh', label: '很高', description: 'xhigh' },
] as const;

export function ComposerReasoningControl({ modelId, revision, disabled, onSavingChange }: {
  modelId: string; revision: number; disabled: boolean; onSavingChange: (saving: boolean) => void;
}) {
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const current = ++generation.current;
    setProfile(null); setLoading(true);
    if (!modelId) { setLoading(false); return; }
    void modelApi.list().then(profiles => {
      if (generation.current !== current) return;
      const selected = profiles.find(item => item.id === modelId);
      if (!selected) throw new Error('当前模型配置已不可用。');
      setProfile(selected);
    }).catch(cause => {
      if (generation.current === current) notify(cause instanceof Error ? cause.message : '读取推理强度失败，请重试。', 'error');
    }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [modelId, revision, reload]);

  const choose = async (value: string) => {
    if (disabled || loading || pending.current || !profile || profile.id !== modelId || !modelProtocols[profile.config.provider].reasoning || !options.some(option => option.value === value)) return;
    const effort = (value || null) as ModelConfig['reasoningEffort'];
    if (profile.config.reasoningEffort === effort) return;
    const current = generation.current;
    pending.current = true; setSaving(true); onSavingChange(true);
    try {
      // Merge into the latest saved model so changing effort cannot replace other settings with an old snapshot.
      const latest = (await modelApi.list()).find(item => item.id === modelId);
      if (!latest) throw new Error('当前模型配置已被删除，请重新选择模型。');
      if (!modelProtocols[latest.config.provider].reasoning) throw new Error('当前协议不使用 OpenAI 推理强度，请重新读取模型设置。');
      const saved = await modelApi.save(latest.id, latest.revision, {
        ...latest.config, reasoningEffort: effort,
        capabilities: { ...latest.config.capabilities, reasoningEffort: effort !== null },
      }, { action: 'keep' }, latest.displayName);
      if (generation.current === current) setProfile(saved);
      notify(`推理强度已设为${options.find(option => option.value === value)!.label}，下一条消息生效。`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '推理强度保存失败，已保留原设置。', 'error');
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
      onSavingChange(false);
    }
  };

  const supportsReasoning = !profile || modelProtocols[profile.config.provider].reasoning;
  const effort = profile?.config.reasoningEffort ?? '';
  const label = options.find(option => option.value === effort)?.label ?? '默认';
  return <div className="composer-reasoning-control" title={supportsReasoning ? '推理强度保存到当前模型，用于后续请求；仅选择供应商支持的档位' : '此协议使用常规模式，不发送 OpenAI 推理强度参数'}>
    {!loading && !profile && modelId ? <button type="button" className="composer-reasoning-retry" disabled={disabled} onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={13} />重试推理设置</button>
      : <Select label="推理强度" className="composer-reasoning-trigger" value={effort} options={options}
        displayValue={saving ? '保存中…' : loading ? '推理 · 读取中' : !supportsReasoning ? '常规模式' : `推理 · ${label}`} disabled={disabled || loading || saving || !profile || !supportsReasoning}
        menuMinWidth={220} menuAlign="end" menuClassName="composer-reasoning-menu" onChange={value => { void choose(value); }} />}
  </div>;
}

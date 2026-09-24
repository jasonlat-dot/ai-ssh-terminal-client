import { useState } from 'react';
import type { FileNode, SavedCommand } from '../types';
import { commandCategoryIcon } from '../data/mock';
import { Icon, Modal } from './Ui';

export function AddCommandDialog({ close, save, categories }: { close: () => void; save: (command: SavedCommand) => Promise<void>; categories: string[] }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [category, setCategory] = useState('系统');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const normalizedCategory = category.trim();
  return <Modal title="添加常用命令" className="add-command-dialog" dismissDisabled={saving} onClose={close}>
    <form className="command-dialog-form" onSubmit={async event => {
      event.preventDefault();
      if (!name.trim() || !command.trim() || !normalizedCategory) { setError('请填写命令名称、分类和命令内容。'); return; }
      setSaving(true); setError('');
      try {
        await save({ id: crypto.randomUUID(), name: name.trim(), command: command.trim(), category: normalizedCategory, icon: commandCategoryIcon(normalizedCategory) });
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : '命令保存失败，请重试。');
        setSaving(false);
      }
    }}>
      <p className="command-dialog-intro">保存自己的运维快捷方式。名称用于识别，点击命令可写入终端，“运行”会直接提交。</p>
      <div className="command-dialog-fields">
        <label htmlFor="new-command-name"><span>命令名称</span><input id="new-command-name" value={name} maxLength={40} disabled={saving} onChange={event => setName(event.target.value)} placeholder="例如：检查磁盘空间" /></label>
        <fieldset className="command-category-picker"><legend>选择分类</legend><div>{categories.map(item => <button type="button" key={item} disabled={saving} className={normalizedCategory === item ? 'selected' : ''} onClick={() => setCategory(item)}><Icon name={commandCategoryIcon(item)} size={15} />{item}</button>)}</div></fieldset>
        <label htmlFor="new-command-category"><span>分类名称</span><input id="new-command-category" value={category} maxLength={24} disabled={saving} onChange={event => setCategory(event.target.value)} placeholder="选择已有分类或输入新分类" /></label>
        <label htmlFor="new-command-value" className="command-value-field"><span>命令内容</span><input id="new-command-value" className="code-input" value={command} disabled={saving} onChange={event => setCommand(event.target.value)} placeholder="例如：df -h" /></label>
      </div>
      {(name.trim() || command.trim()) && <div className="command-dialog-preview"><span className="command-preview-icon"><Icon name={commandCategoryIcon(normalizedCategory)} size={18} /></span><span><strong>{name.trim() || '未命名命令'}</strong><code>{command.trim() || '等待输入命令内容'}</code></span><small>{normalizedCategory || '未分类'}</small></div>}
      {error && <p className="form-error command-dialog-error" role="alert"><Icon name="alert" size={15} />{error}</p>}
      <div className="command-persistence-note"><Icon name="disk" size={15} /><span>保存到客户端持久化存储，重新启动后仍会保留。</span></div>
      <div className="dialog-actions"><button type="button" className="outlined-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" disabled={saving} type="submit">{saving ? '正在保存…' : '保存命令'}</button></div>
    </form>
  </Modal>;
}
export function CreateFileDialog({ close, files, save, path }: { path: string; close: () => void; files: FileNode[]; save: (file: FileNode) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'file' | 'folder'>('file');
  const [error, setError] = useState('');
  return <Modal title="新建文件或文件夹（模拟）" onClose={close}><form className="dialog-form" onSubmit={e => { e.preventDefault(); const trimmed = name.trim(); if (!trimmed || /[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') { setError('请输入有效名称，不能包含路径分隔符。'); return; } if (files.some(file => file.name === trimmed)) { setError('当前目录已存在同名项目。'); return; } save({ id: trimmed, name: trimmed, kind, ...(kind === 'folder' ? { children: [] } : {}) }); }}><p className="muted">位置：{path}</p><label>名称<input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="输入文件或文件夹名称" /></label><label>类型<select value={kind} onChange={e => setKind(e.target.value as 'file' | 'folder')}><option value="file">文件</option><option value="folder">文件夹</option></select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="outlined-button" type="button" onClick={close}>取消</button><button type="submit" className="primary-button">创建</button></div></form></Modal>;
}

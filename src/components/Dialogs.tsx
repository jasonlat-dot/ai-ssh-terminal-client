import { useState } from 'react';
import type { Category, FileNode, Host, SavedCommand } from '../types';
import { categories, flattenFiles } from '../data/mock';
import { Icon, Modal } from './Ui';

export function AddCommandDialog({ close, save }: { close: () => void; save: (command: SavedCommand) => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [category, setCategory] = useState<Category>('系统');
  const [error, setError] = useState('');
  return <Modal title="添加常用命令" onClose={close}><form className="dialog-form" onSubmit={e => { e.preventDefault(); if (!name.trim() || !command.trim()) { setError('请填写命令名称和命令内容。'); return; } save({ id: crypto.randomUUID(), name: name.trim(), command: command.trim(), category, icon: category === 'Docker' ? 'box' : 'file' }); }}><label htmlFor="new-command-name">名称</label><input id="new-command-name" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="例如：检查磁盘" /><label htmlFor="new-command-category">分类</label><select id="new-command-category" value={category} onChange={e => setCategory(e.target.value as Category)}>{categories.filter(item => item !== '全部').map(item => <option key={item}>{item}</option>)}</select><label htmlFor="new-command-value">命令</label><input id="new-command-value" className="code-input" value={command} onChange={e => setCommand(e.target.value)} placeholder="例如：df -h" />{error && <p className="form-error" role="alert">{error}</p>}<p className="muted">仅保存在本次演示中，刷新页面后恢复默认。</p><div className="dialog-actions"><button type="button" className="outlined-button" onClick={close}>取消</button><button className="primary-button" type="submit">保存命令</button></div></form></Modal>;
}
export function CreateFileDialog({ close, files, save }: { close: () => void; files: FileNode[]; save: (file: FileNode) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'file' | 'folder'>('file');
  const [error, setError] = useState('');
  return <Modal title="新建远程项目（模拟）" onClose={close}><form className="dialog-form" onSubmit={e => { e.preventDefault(); const trimmed = name.trim(); if (!trimmed || /[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') { setError('请输入有效名称，不能包含路径分隔符。'); return; } if (files.some(file => file.name === trimmed)) { setError('当前目录已存在同名项目。'); return; } save({ id: trimmed, name: trimmed, kind, ...(kind === 'folder' ? { children: [] } : {}) }); }}><p className="muted">位置：/var/www/app</p><label>名称<input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="输入文件或文件夹名称" /></label><label>类型<select value={kind} onChange={e => setKind(e.target.value as 'file' | 'folder')}><option value="file">文件</option><option value="folder">文件夹</option></select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="outlined-button" type="button" onClick={close}>取消</button><button type="submit" className="primary-button">创建</button></div></form></Modal>;
}
type SearchResult = { id: string; label: string; detail: string; kind: 'host' | 'file' | 'command'; value: string };
export function SearchDialog({ close, hosts, files, commands, choose }: { close: () => void; hosts: Host[]; files: FileNode[]; commands: SavedCommand[]; choose: (kind: SearchResult['kind'], value: string) => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const results: SearchResult[] = [
    ...hosts.map(host => ({ id: `host:${host.id}`, label: host.name, detail: `主机 · ${host.address}`, kind: 'host' as const, value: host.id })),
    ...commands.map(command => ({ id: `command:${command.id}`, label: command.name, detail: command.command, kind: 'command' as const, value: command.command })),
    ...flattenFiles(files).map(file => ({ id: `file:${file.id}`, label: file.name, detail: `文件 · /var/www/app/${file.id}`, kind: 'file' as const, value: file.id })),
  ].filter(result => `${result.label} ${result.detail}`.toLowerCase().includes(query.toLowerCase().trim()));
  const selected = Math.min(index, Math.max(0, results.length - 1));
  return <Modal title="搜索命令、文件或主机" onClose={close} wide><div className="search-dialog"><div className="search-input"><Icon name="search" /><input role="combobox" aria-label="搜索内容" aria-expanded="true" aria-controls="search-results" aria-activedescendant={results[selected]?.id} placeholder="输入名称、命令或 IP 地址…" value={query} onChange={e => { setQuery(e.target.value); setIndex(0); }} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1); setIndex(next); document.getElementById(results[next]?.id)?.scrollIntoView({ block: 'nearest' }); } if (e.key === 'Enter' && results[selected]) { e.preventDefault(); choose(results[selected].kind, results[selected].value); } }} /></div><div id="search-results" role="listbox" aria-label="搜索结果" className="search-results">{results.map((result, i) => <button key={result.id} id={result.id} role="option" aria-selected={i === selected} className={i === selected ? 'selected' : ''} onClick={() => choose(result.kind, result.value)}><Icon name={result.kind === 'host' ? 'server' : result.kind === 'file' ? 'file' : 'terminal'} /><span><strong>{result.label}</strong><small>{result.detail}</small></span><Icon name="right" size={16} /></button>)}{!results.length && <p className="empty-state">没有找到匹配结果</p>}</div><footer>↑ ↓ 选择 <span>Enter 打开</span><span>Esc 关闭</span></footer></div></Modal>;
}

import { useEffect, useRef, useState } from 'react';
import type { ResourceSnapshot } from '../api/terminal';
import type { TerminalRuntime } from '../state/terminalRuntime';
import { resourceBytes, resourcePercent, resourceUptime, watchTerminalResources } from '../state/terminalResources';
import { Icon } from './Ui';
import './TerminalResources.css';

export function TerminalResources({ runtime, visible, connected, title }: {
  runtime: TerminalRuntime; visible: boolean; connected: boolean; title: string;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const polling = useRef<ReturnType<typeof watchTerminalResources> | null>(null);
  const [paused, setPaused] = useState(false);
  const [inViewport, setInViewport] = useState(true);
  const [state, setState] = useState<{ sessionId: string; sample: ResourceSnapshot | null; error: string | null }>({ sessionId: runtime.sessionId, sample: null, error: null });
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setInViewport(entries.some(entry => entry.isIntersecting)));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = root.current, parent = node?.closest('.remote-terminal-view');
    if (!node || !parent || typeof ResizeObserver === 'undefined') return;
    const update = () => node.style.setProperty('--resource-panel-height', `${Math.max(40, node.getBoundingClientRect().top - parent.getBoundingClientRect().top - 8)}px`);
    const observer = new ResizeObserver(update); observer.observe(parent); observer.observe(node); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!runtime.resources || !visible || !inViewport || !connected || paused) return;
    const current = watchTerminalResources(signal => runtime.resources!(signal),
      sample => setState({ sessionId: runtime.sessionId, sample, error: null }),
      () => setState(previous => ({ sessionId: runtime.sessionId,
        sample: previous.sessionId === runtime.sessionId ? previous.sample : null,
        error: '资源采集暂不可用，将自动重试。' })));
    polling.current = current;
    return () => { current.stop(); if (polling.current === current) polling.current = null; };
  }, [runtime, visible, inViewport, connected, paused]);

  const sample = state.sessionId === runtime.sessionId ? state.sample : null;
  const error = state.sessionId === runtime.sessionId ? state.error : null;
  const stale = !!(sample?.stale || error || !connected || paused);
  const memoryPercent = sample?.memoryTotalBytes && sample.memoryUsedBytes != null ? sample.memoryUsedBytes * 100 / sample.memoryTotalBytes : null;
  const network = sample?.network.find(nic => nic.primary) ?? sample?.network[0];
  const disk = sample?.disks.find(item => item.mountPoint === '/') ?? sample?.disks[0];
  const waitingForRates = !!sample?.supported && (sample.cpuPercent == null || !!network && (network.receiveBytesPerSecond == null || network.transmitBytesPerSecond == null));
  const note = !connected ? '连接已断开，监控暂停' : paused ? '监控已暂停' : error || sample?.message || (!sample ? '正在采集服务器资源' : waitingForRates ? '正在计算 CPU 和网速，约 5 秒后更新；网速按这段时间的流量变化计算。' : '每 5 秒更新；网速为这段时间内的平均速度。点击查看详情');
  const boot = sample?.bootTimeSeconds == null ? '—' : new Date(sample.bootTimeSeconds * 1000).toLocaleString('zh-CN', { hour12: false });
  const level = (value: number | null | undefined) => value == null ? 'unknown' : value >= 95 ? 'danger' : value >= 80 ? 'warning' : 'normal';
  const status = !connected ? '已断开' : paused ? '已暂停' : sample?.supported === false ? '暂不支持' : stale ? '旧数据' : !sample || waitingForRates ? '采样中' : '';
  return <details ref={root} className="terminal-resources" data-stale={stale} onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); event.stopPropagation();
    }
  }}>
    <summary aria-label={`${title} 服务器资源，展开详情`} title={note}>
      <span className="resource-monitor-state" data-warning={stale || sample?.supported === false} aria-label={note}><Icon name={stale || sample?.supported === false ? 'alert' : 'signal'} size={12} /></span>
      {status && <span className="resource-sampling">{status}</span>}
      <span className="resource-metric" data-level={level(sample?.cpuPercent)}><Icon name="modelChip" size={12} /><span>CPU</span><strong>{resourcePercent(sample?.cpuPercent)}</strong></span>
      <span className="resource-metric" data-level={level(memoryPercent)}><Icon name="database" size={12} /><span>内存</span><strong>{resourcePercent(memoryPercent)}</strong></span>
      <span className="resource-metric" title={`服务器上传 · ${network?.name ?? '等待网卡数据'}`}><span className="resource-direction">↑</span><strong>{resourceBytes(network?.transmitBytesPerSecond, true)}</strong></span>
      <span className="resource-metric" title={`服务器下载 · ${network?.name ?? '等待网卡数据'}`}><span className="resource-direction">↓</span><strong>{resourceBytes(network?.receiveBytesPerSecond, true)}</strong></span>
      <span className="resource-metric" title={`上次开机：${boot}`}><Icon name="history" size={12} /><strong>{resourceUptime(sample?.uptimeSeconds)}</strong></span>
      <span className="resource-metric" data-level={level(disk?.usePercent)} title={disk ? `${disk.mountPoint} · 已用 ${resourceBytes(disk.usedBytes)} / ${resourceBytes(disk.totalBytes)}` : '等待磁盘数据'}><Icon name="disk" size={12} /><span>{disk?.mountPoint ?? '磁盘'}</span><strong>{resourcePercent(disk?.usePercent)}</strong></span>
      <span className="resource-expand" aria-hidden="true">⌃</span>
    </summary>
    <section className="resource-details" aria-label="服务器资源详情">
      <header><span><Icon name="server" size={16} /><strong>{title}</strong><small>服务器资源</small></span>
        <div><button type="button" disabled={!connected || paused || !runtime.resources} onClick={() => polling.current?.refresh()}><Icon name="refresh" size={12} />刷新</button>
          <button type="button" aria-pressed={paused} onClick={() => setPaused(previous => !previous)}>{paused ? '继续监控' : '暂停监控'}</button></div>
      </header>
      <p className="resource-note" role="status">{note}{stale && sample ? ' · 当前显示上次采样值' : ''}</p>
      <div className="resource-overview">
        <div data-level={level(sample?.cpuPercent)}><span>CPU 使用率</span><strong>{resourcePercent(sample?.cpuPercent)}</strong>{sample?.cpuPercent != null && <meter min={0} max={100} value={sample.cpuPercent} aria-label="CPU 使用率" />}</div>
        <div data-level={level(memoryPercent)}><span>内存使用率</span><strong>{resourcePercent(memoryPercent)}</strong><small>{resourceBytes(sample?.memoryUsedBytes)} / {resourceBytes(sample?.memoryTotalBytes)}</small></div>
        <div><span>运行时长</span><strong>{resourceUptime(sample?.uptimeSeconds)}</strong><small>开机 {boot}</small></div>
      </div>
      <div className="resource-detail-list"><h4>网卡流量 <small>服务器接收为下载，发送为上传</small></h4>
        {sample?.network.length ? sample.network.map(nic => <div key={nic.name}><span>{nic.name}{nic.primary && <small>主网卡</small>}</span><span>↑ {resourceBytes(nic.transmitBytesPerSecond, true)}</span><span>↓ {resourceBytes(nic.receiveBytesPerSecond, true)}</span></div>) : <p>网速采样中或暂无可用网卡数据</p>}
      </div>
      <div className="resource-detail-list"><h4>磁盘使用 <small>本地文件系统</small></h4>
        {sample?.disks.length ? sample.disks.map((item, index) => <div key={`${item.mountPoint}:${index}`} data-level={level(item.usePercent)}><span title={item.mountPoint}>{item.mountPoint}</span><span>{resourceBytes(item.usedBytes)} / {resourceBytes(item.totalBytes)}</span><strong>{resourcePercent(item.usePercent)}</strong></div>) : <p>暂无可用磁盘数据</p>}
      </div>
      {sample && <footer>采样时间 {new Date(sample.sampledAtMs).toLocaleTimeString('zh-CN', { hour12: false })}<span>只读采集 · 不占用交互终端</span></footer>}
    </section>
  </details>;
}

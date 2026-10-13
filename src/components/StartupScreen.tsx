import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Icon } from './Ui';
import { dragAppWindow } from '../state/appWindow';
import { WindowControls } from './WindowControls';
import { StartupParticles } from './StartupParticles';
import { StartupTerminalPreview } from './StartupTerminalPreview';
import './StartupScreen.css';

export type StartupPhase = 'checking' | 'starting' | 'ready' | 'failed' | 'stopped';
export type StartupHealthState = 'idle' | 'probing' | 'up' | 'down' | 'error';

export type StartupHealth = {
  state: StartupHealthState;
  backendUrl: string;
  latencyMs: number | null;
  message: string | null;
  checkedAt: string | null;
};

type StartupScreenProps = {
  phase: StartupPhase;
  message: string;
  logDirectory: string | null;
  retrying: boolean;
  onRetry: () => void;
  onContinue: () => void;
  onStart?: () => void;
  starting?: boolean;
  health?: StartupHealth;
  onRecheckHealth?: () => void;
  rechecking?: boolean;
};

function phaseCopy(phase: StartupPhase) {
  if (phase === 'failed') return { label: '启动失败', title: '内置服务未能启动' };
  if (phase === 'ready') return { label: '启动完成', title: '正在进入工作区' };
  if (phase === 'stopped') return { label: '选择启动方式', title: '开始使用 ShellPilot Rust' };
  if (phase === 'checking') return { label: '正在检查', title: '正在检查运行环境' };
  return { label: '正在启动', title: '正在启动 Rust 内置服务' };
}

function healthLabel(health: StartupHealth | undefined) {
  if (!health || health.state === 'idle') return '检查服务';
  if (health.state === 'probing') return '正在检查…';
  if (health.state === 'up') return health.latencyMs == null ? '服务正常' : `服务正常 · ${health.latencyMs} ms`;
  return '服务暂不可达';
}

export function StartupScreen({ phase, message, logDirectory, retrying, onRetry, onContinue, onStart, starting, health, onRecheckHealth, rechecking }: StartupScreenProps) {
  const copy = phaseCopy(phase);
  const failed = phase === 'failed';
  const choosing = phase === 'stopped';
  const busy = phase === 'checking' || phase === 'starting';
  const locked = busy || !!starting || retrying;
  const terminalRef = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [burstVersion, setBurstVersion] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setMotion(!reduce.matches);
    reduce.addEventListener('change', change);
    return () => reduce.removeEventListener('change', change);
  }, []);
  const start = () => {
    setBurstVersion(version => version + 1);
    if (failed) onRetry();
    else onStart?.();
  };
  const highlightChoice = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'touch') return;
    const b = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--hover-x', `${event.clientX - b.left}px`);
    event.currentTarget.style.setProperty('--hover-y', `${event.clientY - b.top}px`);
  };

  return <main className={`startup-screen is-${phase}${locked ? ' is-working' : ''}`} data-motion={motion ? 'on' : 'off'}>
    <header className="startup-header" onMouseDown={dragAppWindow}>
      <div className="startup-brand">
        <img className="startup-brand-mark" src="/agent-ssh-header.svg" alt="" draggable={false} />
        <span><strong>ShellPilot</strong><small>智能远程开发助手</small></span>
      </div>
      <div className="startup-header-actions">
        <label className="startup-motion-control" data-no-window-drag>
          <input type="checkbox" checked={motion} onChange={event => setMotion(event.target.checked)} aria-label="背景动效" />动效
        </label>
        {onRecheckHealth && <button type="button" className="startup-health-button"
          data-state={health?.state || 'idle'}
          onClick={onRecheckHealth} aria-busy={!!rechecking || health?.state === 'probing'}
          title={health?.backendUrl ? `${health.backendUrl} · ${health.message || ''} · ${health.checkedAt ? new Date(health.checkedAt).toLocaleString() : '尚未检查'}` : '检查内置服务是否可访问'}>
          <Icon name={health?.state === 'up' ? 'check' : 'refresh'} size={16} /><span>{healthLabel(health)}</span>
        </button>}
        <WindowControls />
      </div>
    </header>

    <div className="startup-main">
      <StartupParticles enabled={motion} burstVersion={burstVersion} terminalRef={terminalRef} />
      <div className="startup-ambient" aria-hidden="true" />
      <div className="startup-ambient is-secondary" aria-hidden="true" />
      <div className="startup-layout">
        <section className="startup-content" aria-labelledby="startup-title" aria-busy={locked}>
          <div className="startup-eyebrow"><span />YOUR WORKSPACE, CONNECTED</div>
          <h1 id="startup-title">一个终端，<br /><em>连接更多可能。</em></h1>
          <p className="startup-intro">远程连接、文件管理与 AI 协作，在一个工作区中完成。选择启动方式，即刻开始。</p>
          <div className="startup-choices" aria-label="启动方式">
            {(onStart || failed) && <button type="button" className="startup-choice is-recommended"
              onClick={start} onPointerMove={highlightChoice} disabled={locked || phase === 'ready'}>
              <span className="startup-option-icon"><Icon name={failed ? 'refresh' : 'server'} size={16} /></span>
              <span className="startup-choice-text">
                <span className="startup-choice-title">{retrying ? '正在重试…' : busy || starting ? '正在启动…' : failed ? '重试启动' : '启动内置服务'}
                  {!failed && <span className="startup-recommended-badge">推荐</span>}
                </span>
                <span className="startup-choice-copy">{failed ? '重新检查环境并启动本机服务' : '在本机运行服务，开始使用 SSH 与 AI 助手'}</span>
              </span>
              <Icon name="upRight" size={16} className="startup-choice-arrow" />
            </button>}
            <button type="button" className="startup-choice is-client" onClick={onContinue}
              onPointerMove={highlightChoice} disabled={locked || phase === 'ready'}>
              <span className="startup-option-icon"><Icon name="monitor" size={16} /></span>
              <span className="startup-choice-text">
                <span className="startup-choice-title">直接进入客户端</span>
                <span className="startup-choice-copy">使用本地终端，或连接已有后端</span>
              </span>
              <Icon name="upRight" size={16} className="startup-choice-arrow" />
            </button>
          </div>
          <div className="startup-hint">
            <Icon name="settings" size={16} /><span>{choosing ? '进入后可随时在设置中切换服务方式。'
              : failed ? '可先进入客户端使用本地终端，再到设置中检查服务。'
                : '启动完成后将自动进入工作区。'}</span>
          </div>
          <div className="startup-notice" role={failed ? 'alert' : 'status'} aria-live="polite"
            data-state={failed ? 'failed' : choosing ? health?.state : phase}>
            {!choosing ? <><strong>{copy.title}</strong><span>{message}</span></>
              : health?.checkedAt && health.state !== 'probing' ? <span>{healthLabel(health)}{health.message ? ` · ${health.message}` : ''}</span> : null}
          </div>
          {failed && logDirectory && <div className="startup-log-location">
            <Icon name="folder" size={14} /><span><strong>启动日志目录</strong><span title={logDirectory}>{logDirectory}</span></span>
          </div>}
        </section>

        <StartupTerminalPreview phase={phase} phaseLabel={copy.label} message={message}
          working={locked} motion={motion} terminalRef={terminalRef} />
      </div>
    </div>
    <footer className="startup-footer"><span><i />本地客户端 · ShellPilot</span><span>{choosing ? '选择启动方式，即刻开始' : copy.label}</span></footer>
  </main>;
}

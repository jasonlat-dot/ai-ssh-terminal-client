import { Icon } from './Ui';
import { dragAppWindow } from '../state/appWindow';
import { WindowControls } from './WindowControls';
import './StartupScreen.css';

export type StartupPhase = 'checking' | 'starting' | 'ready' | 'failed' | 'stopped';
export type StartupHealthState = 'idle' | 'probing' | 'up' | 'down' | 'error';
export type StartupHealth = {
  state: StartupHealthState; backendUrl: string; latencyMs: number | null;
  message: string | null; checkedAt: string | null;
};
type Props = {
  exiting?: boolean;
  phase: StartupPhase; message: string; logDirectory: string | null;
  retrying: boolean; onRetry: () => void; onStart: () => void; starting: boolean;
  health: StartupHealth; onRecheckHealth: () => void;
};

/** A geometric terminal silhouette, not an embedded application icon. */
export function StartupMark() {
  return <div className="startup-symbol" aria-hidden="true">
    <svg className="startup-wire" viewBox="0 0 400 260" fill="none">
      <g className="startup-orbit" stroke="currentColor" strokeWidth="1">
        <ellipse cx="200" cy="130" rx="158" ry="88" strokeDasharray="2 9" />
        <path d="M18 132h65m234 0h65M200 14v34m0 164v34" />
        <path d="M70 62l39 23m182 91 39 23M70 198l39-23m182-91 39-23" />
      </g>
      <g className="startup-frame" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M153 66h92c14 0 25 11 25 25v78c0 14-11 25-25 25h-92c-14 0-25-11-25-25V91c0-14 11-25 25-25Z" />
        <path className="startup-frame-inner" d="M144 88h111m-111 3v76c0 7 5 12 12 12h88" />
        <path className="startup-chevron" d="m162 111 21 19-21 19" strokeWidth="5" />
        <path className="startup-command-cursor" d="M203 149h29" strokeWidth="5" />
      </g>
      <g className="startup-points" fill="currentColor">
        <circle cx="41" cy="132" r="2.5" /><circle cx="330" cy="61" r="2" />
        <circle cx="200" cy="29" r="2" /><circle cx="357" cy="132" r="2.5" />
        <circle cx="70" cy="198" r="2" /><circle cx="200" cy="232" r="2" />
      </g>
    </svg>
    <span className="startup-orbit-particle is-one" /><span className="startup-orbit-particle is-two" />
    <span className="startup-symbol-halo" />
  </div>;
}

export function StartupScreen({ phase, message, logDirectory, retrying, onRetry, onStart, starting, health, onRecheckHealth, exiting = false }: Props) {
  const failed = phase === 'failed';
  const stopped = phase === 'stopped';
  const busy = phase === 'checking' || phase === 'starting' || retrying || starting;
  const title = failed ? '工作区暂未就绪' : stopped ? '准备好，开始新的会话' : phase === 'ready' ? '工作区已就绪' : '正在准备你的工作区';
  return <main className={`startup-screen is-${phase}${exiting ? ' is-exiting' : ''}`}>
    <header className="startup-header" onMouseDown={dragAppWindow}>
      <span className="startup-header-wordmark">ShellPilot<span className="startup-header-dot" /></span>
      <WindowControls />
    </header>
    <div className="startup-main">
      <section className="startup-content" aria-labelledby="startup-title" aria-busy={busy}>
        <StartupMark />
        <h1 id="startup-title">Shell<span>Pilot</span><span className="startup-wordmark-cursor" aria-hidden="true">_</span></h1>
        <p className="startup-tagline">让思路沿着终端，走到答案</p>
        <div className="startup-readiness" role={failed ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
          <span className="startup-status-title"><i />{title}</span>
          <div className="startup-progress" aria-hidden="true"><span /></div>
          <p className="startup-status-message">{phase === 'ready' ? '即将进入终端与智能体工作区' : message}</p>
        </div>
        {(failed || stopped) && <div className="startup-actions">
          <button type="button" className="startup-primary" disabled={busy} onClick={failed ? onRetry : onStart}>
            <Icon name={failed ? 'refresh' : 'terminal'} size={16} />{retrying || starting ? '正在启动…' : failed ? '重新启动工作区' : '启动工作区'}
          </button>
          {failed && <button type="button" className="startup-recheck" onClick={onRecheckHealth} disabled={health.state === 'probing'}>
            <Icon name="refresh" size={15} />{health.state === 'probing' ? '正在检查…' : '重新检查'}
          </button>}
        </div>}
        {failed && logDirectory && <p className="startup-log-location"><Icon name="folder" size={14} /><span>日志目录：{logDirectory}</span></p>}
      </section>
    </div>
    <footer className="startup-footer"><span>你的终端协作空间</span><span>SSH <i /> SFTP <i /> AGENT</span></footer>
  </main>;
}

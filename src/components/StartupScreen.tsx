import { Icon } from './Ui';
import './StartupScreen.css';

export type StartupPhase = 'checking' | 'starting' | 'ready' | 'failed' | 'stopped';

export type StartupHealthState = 'idle' | 'probing' | 'up' | 'down' | 'error';

export type StartupHealth = {
  state: StartupHealthState;
  /** 当前探测的后端根地址，方便排错。 */
  backendUrl: string;
  /** 探测耗时（毫秒），仅在 state === 'up' 时使用。 */
  latencyMs: number | null;
  /** 失败原因，state !== 'up' 时展示。 */
  message: string | null;
  /** 上次探测时间。 */
  checkedAt: string | null;
};

type StartupScreenProps = {
  phase: StartupPhase;
  message: string;
  logDirectory: string | null;
  retrying: boolean;
  onRetry: () => void;
  onContinue: () => void;
  /**
   * 当 phase === 'stopped' 时（自动启动被关掉），需要一个“启动”按钮。
   * 留空则不显示按钮，但生产版本应始终传入。
   */
  onStart?: () => void;
  /** stopped 状态下禁用“启动”按钮（例如正在拉起中）。 */
  starting?: boolean;
  /**
   * /api/health 探测结果。仅用于展示，phase 流转仍由父组件依据
   * bundled_backend_status 决定，health 失败不会让启动卡住。
   */
  health?: StartupHealth;
  /** 让父组件重新探测一次；不传则不显示按钮。 */
  onRecheckHealth?: () => void;
  rechecking?: boolean;
};

type StepState = 'done' | 'active' | 'pending' | 'failed';

const steps = [
  { icon: 'monitor' as const, title: '加载界面', detail: '客户端组件已就绪' },
  { icon: 'server' as const, title: '启动服务', detail: '正在检查后端状态' },
  { icon: 'terminal' as const, title: '进入工作区', detail: '服务就绪后自动进入' },
];

function stepState(phase: StartupPhase, index: number): StepState {
  if (phase === 'ready') return 'done';
  if (index === 0) return 'done';
  if (index === 1) {
    if (phase === 'failed') return 'failed';
    if (phase === 'stopped') return 'pending';
    return 'active';
  }
  return 'pending';
}

function phaseCopy(phase: StartupPhase) {
  if (phase === 'failed') return { label: '启动失败', title: '内置服务启动失败' };
  if (phase === 'ready') return { label: '服务已就绪', title: '正在进入工作区' };
  if (phase === 'stopped') return { label: '等待启动', title: '本地服务尚未启动' };
  if (phase === 'checking') return { label: '正在检查', title: '正在检查本地服务' };
  return { label: '正在启动', title: '正在启动内置服务' };
}

function completedSteps(phase: StartupPhase) {
  return phase === 'ready' ? 3 : 1;
}

function healthBadgeLabel(health: StartupHealth | undefined): { label: string; tone: string } {
  if (!health || health.state === 'idle') return { label: '尚未做健康检查', tone: 'is-idle' };
  if (health.state === 'probing') return { label: '健康检查中…', tone: 'is-probing' };
  if (health.state === 'up') return { label: health.latencyMs != null ? `/api/health · UP · ${health.latencyMs}ms` : '/api/health · UP', tone: 'is-up' };
  return { label: health.message ? `/api/health · ${health.message}` : '/api/health · 异常', tone: 'is-down' };
}

export function StartupScreen({ phase, message, logDirectory, retrying, onRetry, onContinue, onStart, starting, health, onRecheckHealth, rechecking }: StartupScreenProps) {
  const copy = phaseCopy(phase);
  const failed = phase === 'failed';
  const stopped = phase === 'stopped';
  const healthBadge = healthBadgeLabel(health);

  return <main className={`startup-screen is-${phase}`}>
    <header className="startup-header">
      <div className="startup-brand">
        <span className="startup-brand-mark"><span /></span>
        <span>
          <strong>Agent SSH</strong>
          <small>智能远程开发助手</small>
        </span>
      </div>
      <div className="startup-header-status">
        <Icon name="server" size={15} />
        <span>{copy.label}</span>
      </div>
      <button
        type="button"
        className={`startup-health-badge ${healthBadge.tone}`}
        onClick={() => { if (onRecheckHealth) onRecheckHealth(); }}
        disabled={!onRecheckHealth || !!rechecking}
        title={health ? `${health.backendUrl}/api/health · ${health.checkedAt ? new Date(health.checkedAt).toLocaleString() : '尚未探测'}` : '尚未做健康检查'}
      >
        <span className="startup-health-badge-dot" aria-hidden="true" />
        <span>{healthBadge.label}</span>
      </button>
    </header>

    <section className="startup-layout">
      <article className="startup-panel" aria-live="polite" aria-busy={!failed && !stopped && phase !== 'ready'}>
        <section className="startup-primary-pane">
          <div className="startup-summary">
            <div className="startup-service-icon" aria-hidden="true">
              <Icon name={failed ? 'alert' : stopped ? 'power' : phase === 'ready' ? 'check' : 'server'} size={28} />
            </div>
            <div className="startup-copy">
              <div className="startup-status-label">
                <i aria-hidden="true" />
                {copy.label}
              </div>
              <h1>{copy.title}</h1>
              <p className={`startup-message ${failed ? 'is-error' : ''}`} role={failed ? 'alert' : 'status'}>
                {message}
              </p>
            </div>
          </div>

          {health && (health.state === 'down' || health.state === 'error') && phase !== 'ready' && (
            <div className="startup-health-detail is-down" role="status">
              <Icon name="alert" size={14} />
              <span>
                /api/health 暂未返回 UP{health.message ? `：${health.message}` : ''}。
                当前地址：<code>{health.backendUrl}</code>，点击右上角“健康检查”徽章可重新探测。
              </span>
            </div>
          )}

          {!failed && !stopped && phase !== 'ready' && <div className="startup-activity" role="status">
            <div className="startup-activity-bars" aria-hidden="true">
              <span /><span /><span /><span />
            </div>
            <span>正在建立本地服务连接</span>
          </div>}

          {stopped && onStart && <div className="startup-recovery">
            <div className="startup-actions">
              <button className="startup-primary" type="button" onClick={onStart} disabled={!!starting}>
                <Icon name="play" size={16} />
                {starting ? '正在启动' : '启动内置服务'}
              </button>
              <button className="startup-secondary" type="button" onClick={onContinue} disabled={!!starting}>
                先进入客户端
              </button>
            </div>
            <p className="startup-caution">继续进入后，依赖后端的功能暂时不可用。</p>
          </div>}

          {failed && <div className="startup-recovery">
            {logDirectory && <div className="startup-log-location">
              <span>启动日志目录</span>
              <code title={logDirectory}>{logDirectory}</code>
              <small>请在此目录查看后端日志以定位详细原因</small>
            </div>}
            <div className="startup-actions">
              <button className="startup-primary" type="button" onClick={onRetry} disabled={retrying}>
                <Icon name="refresh" size={16} />
                {retrying ? '正在重试' : '重试启动'}
              </button>
              <button className="startup-secondary" type="button" onClick={onContinue} disabled={retrying}>
                先进入客户端
              </button>
            </div>
            <p className="startup-caution">继续进入后，依赖后端的功能暂时不可用。</p>
          </div>}
        </section>

        <aside className="startup-checklist" aria-label="启动检查">
          <header>
            <span>启动检查</span>
            <small>{completedSteps(phase)} / {steps.length}</small>
          </header>
          <ol className="startup-steps">
            {steps.map((step, index) => {
              const state = stepState(phase, index);
              return <li key={step.title} className={`is-${state}`}>
                <span className="startup-step-marker">
                  {state === 'done' ? <Icon name="check" size={15} /> : <Icon name={state === 'failed' ? 'alert' : step.icon} size={15} />}
                </span>
                <span>
                  <strong>{step.title}</strong>
                  <small>{index === 1 && failed ? '启动失败，请检查配置与日志' : step.detail}</small>
                </span>
              </li>;
            })}
          </ol>
          <div className="startup-auto-enter">
            <Icon name="bolt" size={15} />
            <span>服务就绪后自动进入客户端</span>
          </div>
        </aside>
      </article>
    </section>

    <footer className="startup-footer">
      <span><i /> 本地运行环境</span>
      <span>启动完成后自动进入</span>
    </footer>
  </main>;
}

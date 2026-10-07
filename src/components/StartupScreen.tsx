import { Icon } from './Ui';
import './StartupScreen.css';

export type StartupPhase = 'checking' | 'starting' | 'ready' | 'failed';

type StartupScreenProps = {
  phase: StartupPhase;
  message: string;
  logDirectory: string | null;
  retrying: boolean;
  onRetry: () => void;
  onContinue: () => void;
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
  if (index === 1) return phase === 'failed' ? 'failed' : 'active';
  return 'pending';
}

function phaseCopy(phase: StartupPhase) {
  if (phase === 'failed') return { label: '启动失败', title: '内置服务启动失败' };
  if (phase === 'ready') return { label: '服务已就绪', title: '正在进入工作区' };
  if (phase === 'checking') return { label: '正在检查', title: '正在检查本地服务' };
  return { label: '正在启动', title: '正在启动内置服务' };
}

function completedSteps(phase: StartupPhase) {
  return phase === 'ready' ? 3 : 1;
}

export function StartupScreen({ phase, message, logDirectory, retrying, onRetry, onContinue }: StartupScreenProps) {
  const copy = phaseCopy(phase);
  const failed = phase === 'failed';

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
    </header>

    <section className="startup-layout">
      <article className="startup-panel" aria-live="polite" aria-busy={!failed && phase !== 'ready'}>
        <section className="startup-primary-pane">
          <div className="startup-summary">
            <div className="startup-service-icon" aria-hidden="true">
              <Icon name={failed ? 'alert' : phase === 'ready' ? 'check' : 'server'} size={28} />
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

          {!failed && phase !== 'ready' && <div className="startup-activity" role="status">
            <div className="startup-activity-bars" aria-hidden="true">
              <span /><span /><span /><span />
            </div>
            <span>正在建立本地服务连接</span>
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

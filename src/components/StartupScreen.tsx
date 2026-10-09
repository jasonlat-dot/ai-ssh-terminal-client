import { AccentIcon, Badge, Icon } from './Ui';
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

const steps = [
  { icon: 'monitor' as const, title: '加载客户端' },
  { icon: 'server' as const, title: '启动内置服务' },
  { icon: 'terminal' as const, title: '进入工作区' },
];

function phaseCopy(phase: StartupPhase) {
  if (phase === 'failed') return { label: '启动失败', title: '内置服务未能启动' };
  if (phase === 'ready') return { label: '启动完成', title: '正在进入工作区' };
  if (phase === 'stopped') return { label: '选择启动方式', title: '开始使用 Agent SSH' };
  if (phase === 'checking') return { label: '正在检查', title: '正在检查运行环境' };
  return { label: '正在启动', title: '正在启动内置服务' };
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
  const healthTone = health?.state === 'up' ? 'success'
    : health?.state === 'down' || health?.state === 'error' ? 'amber'
      : health?.state === 'probing' ? 'blue' : 'neutral';

  return <main className={`startup-screen is-${phase}`}>
    <header className="startup-header">
      <div className="startup-brand">
        <img className="startup-brand-mark" src="/icon.svg" alt="" />
        <span><strong>Agent SSH</strong><small>智能远程开发助手</small></span>
      </div>
      {onRecheckHealth && <button type="button" className="startup-health-button"
        onClick={onRecheckHealth} aria-busy={!!rechecking || health?.state === 'probing'}
        title={health?.backendUrl ? `${health.backendUrl} · ${health.message || ''} · ${health.checkedAt ? new Date(health.checkedAt).toLocaleString() : '尚未检查'}` : '检查内置服务是否可访问'}>
        <Badge tone={healthTone} icon={health?.state === 'up' ? 'check' : 'refresh'}>{healthLabel(health)}</Badge>
      </button>}
    </header>

    <div className="startup-layout">
      <section className="startup-panel" aria-labelledby="startup-title" aria-busy={busy}>
        <div className="startup-intro">
          <AccentIcon icon={choosing ? 'terminal' : failed ? 'alert' : 'server'}
            tone={failed ? 'danger' : 'blue'} size={24} className="startup-service-icon" />
          <Badge tone={failed ? 'danger' : choosing ? 'neutral' : 'blue'}>{copy.label}</Badge>
          <h1 id="startup-title">{copy.title}</h1>
          <p className="startup-message" role={failed ? 'alert' : 'status'}>
            {choosing ? '启动本机服务开始使用，或进入客户端连接已有后端。' : message}
          </p>
        </div>

        {choosing && <div className="startup-choices" aria-label="启动方式">
          {onStart && <button type="button" className="startup-choice is-primary" onClick={onStart} disabled={!!starting}>
            <AccentIcon icon="server" tone="blue" size={22} className="startup-choice-icon" />
            <span className="startup-choice-copy">
              <span className="startup-choice-title">{starting ? '正在启动…' : '启动内置服务'}<Badge tone="blue">推荐</Badge></span>
              <span className="startup-choice-description">在本机运行后端，使用 SSH 连接和 AI 助手。</span>
            </span>
            <Icon name="right" size={18} />
          </button>}
          <button type="button" className="startup-choice" onClick={onContinue} disabled={!!starting}>
            <AccentIcon icon="monitor" tone="violet" size={22} className="startup-choice-icon" />
            <span className="startup-choice-copy">
              <span className="startup-choice-title">直接进入客户端</span>
              <span className="startup-choice-description">使用本地终端，或在设置中连接已有后端。</span>
            </span>
            <Icon name="right" size={18} />
          </button>
        </div>}

        {!choosing && <ol className="startup-steps" aria-label="启动进度">
          {steps.map((step, index) => {
            const state = phase === 'ready' || index === 0 ? 'done'
              : index === 1 ? failed ? 'failed' : 'active' : 'pending';
            return <li key={step.title} className={`is-${state}`}>
              <span className="startup-step-marker"><Icon name={state === 'done' ? 'check' : state === 'failed' ? 'alert' : step.icon} size={16} /></span>
              <span>{step.title}</span>
            </li>;
          })}
        </ol>}

        {failed && <div className="startup-recovery">
          {logDirectory && <div className="startup-log-location">
            <Icon name="folder" size={16} /><span><strong>启动日志目录</strong><span title={logDirectory}>{logDirectory}</span></span>
          </div>}
          <div className="startup-actions">
            <button className="startup-primary" type="button" onClick={onRetry} disabled={retrying}>
              <Icon name="refresh" size={16} />{retrying ? '正在重试…' : '重试启动'}
            </button>
            <button className="startup-secondary" type="button" onClick={onContinue} disabled={retrying}>直接进入客户端</button>
          </div>
        </div>}

        <div className="startup-panel-note">
          <Icon name={choosing || failed ? 'settings' : 'bolt'} size={14} />
          <span>{choosing ? '进入后可随时在设置中启动内置服务或修改后端地址。'
            : failed ? '可先进入客户端使用本地终端，再到设置中检查服务。'
              : '启动完成后将自动进入工作区。'}</span>
        </div>
      </section>
    </div>
    <footer className="startup-footer"><Icon name="monitor" size={13} /><span>本地客户端 · Agent SSH</span></footer>
  </main>;
}

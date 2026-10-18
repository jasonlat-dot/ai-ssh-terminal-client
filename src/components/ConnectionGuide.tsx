import { createPortal } from 'react-dom';
import type { AgentProject } from '../api/agent';
import type { Host } from '../types';
import { AccentIcon, Icon, Modal } from './Ui';
import { Select } from './Select';
import './ConnectionGuide.css';

export type ConnectionGuideStep = 0 | 1 | 2 | 3;
export type ConnectionGuideState = {
  open: boolean;
  step: ConnectionGuideStep;
  task: 'connection' | 'project' | 'model' | null;
  connectionId: string;
  projectId: string;
};

const steps = [
  { icon: 'server', title: '保存 SSH 连接', detail: '告诉 ShellPilot 服务器在哪里' },
  { icon: 'folder', title: '创建服务器项目', detail: '为这个项目绑定一台服务器' },
  { icon: 'chat', title: '开始项目对话', detail: '让 AI 在正确的服务器上工作' },
] as const;

export function ConnectionGuide({ state, hosts, projects, modelReady, connected, busy, error,
  onClose, onStep, onConnection, onProject, onCreateConnection, onCreateProject, onModels, onStart, onFinish }: {
  state: ConnectionGuideState; hosts: Host[]; projects: AgentProject[]; modelReady: boolean;
  connected: boolean; busy: boolean; error: string;
  onClose: () => void; onStep: (step: ConnectionGuideStep) => void;
  onConnection: (id: string) => void; onProject: (id: string) => void;
  onCreateConnection: () => void; onCreateProject: () => void; onModels: () => void;
  onStart: () => void; onFinish: (example?: string) => void;
}) {
  const host = hosts.find(item => item.id === state.connectionId);
  const availableProjects = projects.filter(item => item.connectionId === host?.id);
  const project = availableProjects.find(item => item.id === state.projectId);
  const current = Math.min(state.step, 2);
  const complete = state.step === 3 && connected && !!project;
  const canVisit = (step: number) => step === 0 || (step === 1 ? !!host : !!project);

  return createPortal(<Modal icon="book" iconTone="blue" title="SSH 新手指引" className="connection-onboarding" onClose={onClose}>
    <div className="connection-onboarding-layout">
      <nav className="connection-onboarding-steps" aria-label="连接指引步骤">
        <p className="connection-onboarding-eyebrow">从连接到第一条指令</p>
        <ol>{steps.map((step, index) => <li key={step.title}>
          <button type="button" data-autofocus={current === index || undefined} disabled={busy || !canVisit(index)} aria-current={current === index ? 'step' : undefined}
            className={current === index ? 'is-current' : ''} onClick={() => onStep(index as ConnectionGuideStep)}>
            <span className="connection-onboarding-number">{(index === 0 && host) || (index === 1 && project) || (index === 2 && complete)
              ? <Icon name="check" size={15} /> : `0${index + 1}`}</span>
            <span><strong>{step.title}</strong><small>{step.detail}</small></span>
          </button>
        </li>)}</ol>
        <div className="connection-onboarding-boundary"><Icon name="fingerprint" size={17} /><p>普通对话用于问答。<br />操作服务器，请在绑定 SSH 的项目里新建对话。</p></div>
      </nav>
      <section className="connection-onboarding-main" aria-labelledby="connection-onboarding-heading">
        <div className="connection-onboarding-heading">
          <AccentIcon icon={steps[current].icon} tone="blue" size={22} />
          <span>{complete ? '准备就绪' : `第 ${current + 1} 步，共 3 步`}</span>
        </div>
        <div key={state.step} className="connection-onboarding-page">
          <h3 id="connection-onboarding-heading">{complete ? '你的服务器对话已准备好' : ['先保存一台 SSH 服务器', '给服务器建一个项目', '从项目开始，让 AI 连接服务器'][current]}</h3>
          <p className="connection-onboarding-description">{[
            '填写服务器地址、端口、用户名和认证方式。保存后，后面的项目就能选择这台服务器。',
            '项目用来归档对话，并确定操作目标。填写项目名称，选择刚保存的 SSH 连接即可。',
            complete ? '接下来可以输入任务，查看执行过程。需要审批的命令会等你确认后执行。' : '新建项目对话时会自动连接绑定的服务器。连接就绪后，再输入你要完成的任务。',
          ][current]}</p>
          {state.step === 0 && <>
            <div className="connection-onboarding-preview" aria-label="SSH 连接需要的信息">
              <div><Icon name="server" size={18} /><strong>你的 SSH 服务器</strong></div>
              <dl><div><dt>服务器地址</dt><dd>IP 地址或域名</dd></div><div><dt>连接端口</dt><dd>通常为 22</dd></div><div><dt>登录认证</dt><dd>密码或私钥</dd></div></dl>
            </div>
            {hosts.length > 0 && <label className="connection-onboarding-field">也可以使用已有连接
              <Select label="指引使用的 SSH 连接" value={host?.id ?? ''} disabled={busy} onChange={onConnection}
                options={hosts.map(item => ({ value: item.id, label: `${item.name} · ${item.user}@${item.address}` }))} />
            </label>}
            <button type="button" className="connection-onboarding-create" disabled={busy} onClick={onCreateConnection}><Icon name="plus" size={16} />新建 SSH 连接<Icon name="upRight" size={15} /></button>
            <p className="connection-onboarding-hint">保存连接后会回到这里。保存配置不代表已验证能够连接服务器。</p>
          </>}
          {state.step === 1 && <>
            <div className="connection-onboarding-target"><AccentIcon icon="server" tone="cyan" /><div><small>本次使用的服务器</small><strong>{host?.name ?? '请先选择 SSH 连接'}</strong><span>{host ? `${host.user}@${host.address}:${host.port ?? 22}` : '返回上一步选择或新建连接'}</span></div></div>
            {!!availableProjects.length && <label className="connection-onboarding-field">使用这台服务器的已有项目
              <Select label="指引使用的服务器项目" value={project?.id ?? ''} disabled={busy} onChange={onProject}
                options={availableProjects.map(item => ({ value: item.id, label: item.name }))} />
            </label>}
            <button type="button" className="connection-onboarding-create" disabled={busy || !host} onClick={onCreateProject}><Icon name="plus" size={16} />新建服务器项目<Icon name="upRight" size={15} /></button>
            <p className="connection-onboarding-hint">会为你预选上一步的连接。项目保存后，再继续创建对话。</p>
          </>}
          {state.step >= 2 && <>
            <div className="connection-onboarding-target"><AccentIcon icon={complete ? 'check' : 'folder'} tone={complete ? 'success' : 'blue'} /><div><small>{complete ? '当前服务器项目' : '即将创建对话的项目'}</small><strong>{project?.name ?? '请先选择服务器项目'}</strong><span>{host ? `${host.user}@${host.address}:${host.port ?? 22}` : '返回前面步骤完成配置'}</span></div></div>
            {!modelReady && <div className="connection-onboarding-model"><Icon name="modelChip" size={18} /><div><strong>还需要一个可用模型</strong><p>先在模型设置中添加并选择模型，再返回这里继续。</p></div><button type="button" disabled={busy} onClick={onModels}>配置模型<Icon name="right" size={14} /></button></div>}
            {complete ? <div className="connection-onboarding-examples"><strong>第一句话，可以从这些开始</strong>{['查看这台服务器的磁盘使用情况', '检查这台服务器的 Docker 容器状态'].map(example => <button type="button" key={example} disabled={busy} onClick={() => onFinish(example)}><Icon name="chat" size={15} /><span>{example}</span><Icon name="right" size={14} /></button>)}<small>点击只填入输入框，由你确认后发送。</small></div>
              : <p className="connection-onboarding-hint">左侧项目名称右侧的对话图标，也可以新建服务器对话。仅打开本地 CMD 不会绑定远程服务器。</p>}
            {state.step === 3 && !connected && <p className="connection-onboarding-error" role="status">服务器连接已断开，可以重新创建项目对话进行连接。</p>}
          </>}
          {error && <p className="connection-onboarding-error" role="alert">{error}</p>}
        </div>
        <footer className="connection-onboarding-footer">
          <button type="button" className="connection-onboarding-back" disabled={busy} onClick={current === 0 ? onClose : () => onStep((current - 1) as ConnectionGuideStep)}>{current === 0 ? '稍后再看' : '上一步'}</button>
          {current < 2 ? <button type="button" className="primary-button" disabled={busy || (current === 0 ? !host : !project)} onClick={() => onStep((current + 1) as ConnectionGuideStep)}>{current === 0 ? '下一步：创建项目' : '下一步：开始对话'}<Icon name="right" size={15} /></button>
            : <button type="button" className="primary-button" disabled={busy || !project || !modelReady} onClick={complete ? () => onFinish() : onStart}>{busy ? '正在准备…' : complete ? '进入服务器对话' : '创建服务器对话'}<Icon name="right" size={15} /></button>}
        </footer>
      </section>
    </div>
  </Modal>, document.body);
}

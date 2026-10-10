import { Fragment, useEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import type { StartupPhase } from './StartupScreen';
import { Icon } from './Ui';

type DialogueScene = {
  phase: number;
  agent: boolean;
  tool: boolean;
  command: string;
  output: boolean;
  rows: number;
  toolState: string;
  receiving: boolean;
  streaming: boolean;
  answer: boolean;
};

const question = '帮我看看服务器磁盘空间够不够？';
const answer = '空间够用。系统盘已用 64%，剩余约 36 GB；数据盘已用 36%，暂不需要清理。';
const headers = ['文件系统', '总容量', '已使用', '使用率'];
const outputRows = [
  ['/dev/sda1', '100G', '64G', '64%'],
  ['tmpfs', '2.0G', '8.0M', '1%'],
  ['/dev/sdb1', '200G', '72G', '36%'],
];
const flowPhases = ['提出问题', 'Agent 执行', '读取结果', '回答用户'];
const demoPhases = ['type', 'execute', 'analyze', 'done'];
const startupSteps = [
  { icon: 'monitor' as const, title: '加载客户端' },
  { icon: 'server' as const, title: '启动内置服务' },
  { icon: 'terminal' as const, title: '进入工作区' },
];
const initialScene: DialogueScene = {
  phase: 0, agent: false, tool: false, command: '', output: false, rows: 0,
  toolState: '准备执行', receiving: false, streaming: false, answer: false,
};
const completedScene: DialogueScene = {
  phase: 3, agent: true, tool: true, command: 'df -h', output: true, rows: 3,
  toolState: '已完成', receiving: false, streaming: false, answer: true,
};

/** The dialogue is a local illustration; backend startup and health remain separate. */
export function StartupTerminalPreview({ phase, phaseLabel, message, working, motion, terminalRef }: {
  phase: StartupPhase;
  phaseLabel: string;
  message: string;
  working: boolean;
  motion: boolean;
  terminalRef: RefObject<HTMLDivElement | null>;
}) {
  const choosing = phase === 'stopped';
  const failed = phase === 'failed';
  const visualRef = useRef<HTMLElement>(null);
  const [scene, setScene] = useState(initialScene);
  const [cycle, setCycle] = useState(0);
  const [replayVersion, setReplayVersion] = useState(0);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animated = motion && !reduced;

  useEffect(() => {
    const visual = visualRef.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changeVisibility = () => setPageVisible(!document.hidden);
    const changeMotion = () => setReduced(reduce.matches);
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting));
    if (visual) observer.observe(visual);
    document.addEventListener('visibilitychange', changeVisibility);
    reduce.addEventListener('change', changeMotion);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', changeVisibility);
      reduce.removeEventListener('change', changeMotion);
    };
  }, []);

  useEffect(() => {
    if (!choosing) return;
    if (!animated) { setScene(completedScene); setCycle(value => value + 1); return; }
    if (!visible || !pageVisible) {
      setScene(previous => ({ ...previous, streaming: false, receiving: false }));
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveWait: ((valid: boolean) => void) | undefined;
    const wait = (ms: number) => new Promise<boolean>(resolve => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve(!cancelled);
      }, ms);
    });
    // Keep the supplied demo's delays, command typing speed and row cadence.
    const play = async () => {
      while (!cancelled) {
        setScene(initialScene);
        setCycle(value => value + 1);
        if (!await wait(1100)) return;
        setScene(previous => ({ ...previous, agent: true }));
        if (!await wait(1000)) return;
        setScene(previous => ({ ...previous, phase: 1, tool: true, toolState: '执行中' }));
        for (const char of 'df -h') {
          setScene(previous => ({ ...previous, command: previous.command + char }));
          if (!await wait(100)) return;
        }
        if (!await wait(600)) return;
        setScene(previous => ({ ...previous, phase: 2, output: true }));
        for (let i = 0; i < outputRows.length; i++) {
          setScene(previous => ({ ...previous, rows: i + 1 }));
          if (!await wait(330)) return;
        }
        setScene(previous => ({ ...previous, toolState: '结果已返回', receiving: true, streaming: true }));
        if (!await wait(1300)) return;
        setScene(previous => ({ ...previous, phase: 3, toolState: '已完成', receiving: false, answer: true }));
        if (!await wait(8500)) return;
      }
    };
    void play();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.(false);
    };
  }, [choosing, animated, visible, pageVisible, replayVersion]);

  const resetTilt = () => {
    const visual = visualRef.current;
    if (!visual) return;
    for (const key of ['--tilt-x', '--tilt-y']) visual.style.setProperty(key, '0deg');
    for (const key of ['--shift-x', '--shift-y']) visual.style.setProperty(key, '0px');
  };
  useEffect(() => { if (!animated) resetTilt(); }, [animated]);
  const tilt = (event: PointerEvent<HTMLElement>) => {
    if (!animated || event.pointerType === 'touch') return;
    const b = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - b.left) / b.width - .5;
    const y = (event.clientY - b.top) / b.height - .5;
    event.currentTarget.style.setProperty('--tilt-y', `${x * 5}deg`);
    event.currentTarget.style.setProperty('--tilt-x', `${-y * 4}deg`);
    event.currentTarget.style.setProperty('--shift-x', `${x * 9}px`);
    event.currentTarget.style.setProperty('--shift-y', `${y * 7}px`);
  };
  const receiving = choosing && animated && pageVisible && visible && scene.receiving;
  const streaming = choosing && animated && pageVisible && visible && scene.streaming;

  return <section ref={visualRef} className="startup-visual" aria-label="Agent 协作流程演示与启动进度"
    onPointerMove={tilt} onPointerLeave={resetTilt}>
    <div className="startup-stage-grid" aria-hidden="true" />
    <div className="startup-stage-line" aria-hidden="true" />
    <span className="startup-stage-caption" aria-hidden="true">ASK → ACT → ANSWER</span>
    <div className={`startup-ai-node${receiving ? ' is-receiving' : ''}`} aria-hidden="true">
      <span className="startup-node-symbol"><Icon name="sparkles" size={15} /></span>AI 协作<span className="startup-node-light" />
    </div>
    <div className="startup-ssh-node" aria-hidden="true"><Icon name="fingerprint" size={13} />SSH 远程连接</div>
    <div className="startup-terminal" ref={terminalRef} data-demo-phase={choosing ? demoPhases[scene.phase] : 'idle'}>
      <div className="startup-terminal-bar">
        <span className="startup-terminal-dot" aria-hidden="true" /><span className="startup-terminal-dot" aria-hidden="true" /><span className="startup-terminal-dot" aria-hidden="true" />
        <span className="startup-terminal-title">{choosing ? 'Agent 对话 · 演示' : `~/workspace · ${phaseLabel}`}</span>
        <button className="startup-demo-replay" type="button" disabled={!choosing}
          onClick={() => setReplayVersion(version => version + 1)}>重播演示</button>
      </div>
      <div className="startup-terminal-body">
        {choosing ? <div className="startup-dialogue" aria-hidden="true">
          <div className="startup-conversation" key={cycle}>
            <div className="startup-user-question"><span>{question}</span></div>
            {scene.agent && <div className="startup-agent-action"><span className="startup-agent-avatar">✦</span>
              <span>{animated ? '我来检查各磁盘的使用情况。' : '我会检查各磁盘的容量、使用率和挂载情况。'}</span>
            </div>}
          </div>
          {scene.tool && <div className="startup-tool-card">
            <div className="startup-tool-caption"><span><Icon name="terminal" size={11} />SSH · execute_command</span><span className="startup-tool-state">{scene.toolState}</span></div>
            <div className="startup-code-line"><span className="startup-prompt">❯</span><span className="startup-command">{scene.command}</span><span className="startup-cursor" /></div>
            <div className="startup-demo-output">
              {scene.output && <div className="startup-output-row is-header">{headers.map(value => <span key={value}>{value}</span>)}</div>}
              {outputRows.slice(0, scene.rows).map(row => <div className="startup-output-row" key={row[0]}>
                {row.map((value, index) => <span key={index} className={index === 3 ? 'startup-output-value' : undefined}>{value}</span>)}
              </div>)}
            </div>
          </div>}
          {scene.answer && <div className="startup-ai-strip is-complete"><Icon name="sparkles" size={14} /><div><strong>Agent · 根据执行结果</strong><small>{answer}</small></div></div>}
          <div className="startup-agent-demo-label">对话、命令及结果均为演示</div>
        </div> : <>
          <div className="startup-code-line" aria-hidden="true"><span className="startup-prompt">❯</span><span className="startup-command">agent ssh --local</span><span className="startup-cursor" /></div>
          <ol className="startup-steps" aria-label="启动进度">
            {startupSteps.map((step, index) => {
              const state = phase === 'ready' || (phase !== 'checking' && index === 0) ? 'done'
                : (phase === 'checking' ? index === 0 : index === 1) ? failed ? 'failed' : 'active' : 'pending';
              return <li key={step.title} className={`startup-code-line is-${state}`}>
                <Icon name={state === 'done' ? 'check' : state === 'failed' ? 'alert' : step.icon} size={13} />
                <span>{step.title}{state === 'active' ? '…' : ''}</span>
              </li>;
            })}
          </ol>
          <hr className="startup-terminal-divider" />
          <div className={`startup-code-line startup-terminal-status${failed ? ' is-error' : ' is-dim'}`}>{message}</div>
          <div className="startup-ai-strip" aria-hidden="true"><Icon name="sparkles" size={14} /><div>
            <strong>{working ? '正在准备你的工作区' : failed ? '服务启动需要检查' : '让 AI 理解你的工作上下文'}</strong>
            <small>{working ? '环境检查 → 服务初始化 → 终端就绪' : failed ? '重试启动，或直接进入客户端。' : '从命令执行到结果分析，让操作更连贯。'}</small>
          </div></div>
        </>}
      </div>
    </div>
    <div className="startup-flow-phases" aria-hidden="true">
      {flowPhases.map((name, index) => <Fragment key={name}>
        {index > 0 && <span className="startup-phase-connector" />}
        <span className={`startup-flow-phase${choosing && scene.phase === index ? ' is-active' : ''}`}>{name}</span>
      </Fragment>)}
    </div>
    <div className="startup-capabilities" aria-hidden="true">
      <span><Icon name="terminal" size={13} />SSH 终端</span><b>·</b><span><Icon name="sparkles" size={13} />AI 助手</span><b>·</b><span><Icon name="folder" size={13} />文件管理</span>
    </div>
    <span className={`startup-stream-packet${streaming ? ' is-flowing' : ''}`} aria-hidden="true" />
    <span className={`startup-stream-packet is-second${streaming ? ' is-flowing' : ''}`} aria-hidden="true" />
  </section>;
}

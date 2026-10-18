import { Fragment, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Icon } from './Ui';
import { TerminalWelcomeParticles } from './TerminalWelcomeParticles';
import './TerminalWelcomeDemo.css';

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
const initialScene: DialogueScene = {
  phase: 0, agent: false, tool: false, command: '', output: false, rows: 0,
  toolState: '准备执行', receiving: false, streaming: false, answer: false,
};
const completedScene: DialogueScene = {
  phase: 3, agent: true, tool: true, command: 'df -h', output: true, rows: 3,
  toolState: '已完成', receiving: false, streaming: false, answer: true,
};

/** Local illustration only. Never connects, executes commands or sends model requests. */
export function TerminalWelcomeDemo() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLElement>(null);
  const [scene, setScene] = useState(initialScene);
  const [cycle, setCycle] = useState(0);
  const [replayVersion, setReplayVersion] = useState(0);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animated = !reduced;

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
  }, [animated, visible, pageVisible, replayVersion]);

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
  const receiving = animated && pageVisible && visible && scene.receiving;
  const streaming = animated && pageVisible && visible && scene.streaming;

  return <div className="terminal-demo-scene" data-motion={animated ? 'on' : 'off'}>
    <TerminalWelcomeParticles enabled={animated} burstVersion={replayVersion} terminalRef={terminalRef} />
    <section ref={visualRef} className="terminal-demo-visual" aria-label="智能体协作流程演示"
    onPointerMove={tilt} onPointerLeave={resetTilt}>
    <div className="terminal-demo-stage-grid" aria-hidden="true" />
    <div className="terminal-demo-stage-line" aria-hidden="true" />
    <span className="terminal-demo-stage-caption" aria-hidden="true">ASK → ACT → ANSWER</span>
    <div className={`terminal-demo-ai-node${receiving ? ' is-receiving' : ''}`} aria-hidden="true">
      <span className="terminal-demo-node-symbol"><Icon name="sparkles" size={15} /></span>AI 协作<span className="terminal-demo-node-light" />
    </div>
    <div className="terminal-demo-ssh-node" aria-hidden="true"><Icon name="fingerprint" size={13} />SSH 远程连接</div>
    <div className="terminal-demo-terminal" ref={terminalRef} data-demo-phase={demoPhases[scene.phase]}>
      <div className="terminal-demo-terminal-bar">
        <span className="terminal-demo-terminal-title">Agent 对话 · 演示</span>
        <button className="terminal-demo-replay" type="button"
          onClick={() => setReplayVersion(version => version + 1)}>重播演示</button>
      </div>
      <div className="terminal-demo-terminal-body">
        <div className="terminal-demo-dialogue" aria-hidden="true">
          <div className="terminal-demo-conversation" key={cycle}>
            <div className="terminal-demo-user-question"><span>{question}</span></div>
            {scene.agent && <div className="terminal-demo-agent-action"><span className="terminal-demo-agent-avatar"><Icon name="bot" size={13} /></span>
              <span>{animated ? '我来检查各磁盘的使用情况。' : '我会检查各磁盘的容量、使用率和挂载情况。'}</span>
            </div>}
          </div>
          {scene.tool && <div className="terminal-demo-tool-card">
            <div className="terminal-demo-tool-caption"><span><Icon name="terminal" size={11} />SSH · execute_command</span><span className="terminal-demo-tool-state">{scene.toolState}</span></div>
            <div className="terminal-demo-code-line"><span className="terminal-demo-prompt">❯</span><span className="terminal-demo-command">{scene.command}</span><span className="terminal-demo-cursor" /></div>
            <div className="terminal-demo-output">
              {scene.output && <div className="terminal-demo-output-row is-header">{headers.map(value => <span key={value}>{value}</span>)}</div>}
              {outputRows.slice(0, scene.rows).map(row => <div className="terminal-demo-output-row" key={row[0]}>
                {row.map((value, index) => <span key={index} className={index === 3 ? 'terminal-demo-output-value' : undefined}>{value}</span>)}
              </div>)}
            </div>
          </div>}
          {scene.answer && <div className="terminal-demo-ai-strip is-complete"><Icon name="sparkles" size={14} /><div><strong>Agent · 根据执行结果</strong><small>{answer}</small></div></div>}
          <div className="terminal-demo-agent-demo-label">对话、命令及结果均为演示</div>
        </div>
      </div>
    </div>
    <div className="terminal-demo-flow-phases" aria-hidden="true">
      {flowPhases.map((name, index) => <Fragment key={name}>
        {index > 0 && <span className="terminal-demo-phase-connector" />}
        <span className={`terminal-demo-flow-phase${scene.phase === index ? ' is-active' : ''}`}>{name}</span>
      </Fragment>)}
    </div>
    <div className="terminal-demo-capabilities" aria-hidden="true">
      <span><Icon name="terminal" size={13} />SSH 终端</span><b>·</b><span><Icon name="sparkles" size={13} />AI 助手</span><b>·</b><span><Icon name="folder" size={13} />文件管理</span>
    </div>
    <span className={`terminal-demo-stream-packet${streaming ? ' is-flowing' : ''}`} aria-hidden="true" />
    <span className={`terminal-demo-stream-packet is-second${streaming ? ' is-flowing' : ''}`} aria-hidden="true" />
  </section></div>;
}

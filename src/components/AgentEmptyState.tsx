import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './AgentEmptyState.css';

const suggestions = {
  general: ['贴一段报错，一起找出原因。', '说说你的目标，一起拆解下一步。', '带上代码或附件，把细节理清楚。', '从一个想法开始，慢慢把它变成方案。'],
  server: ['看看服务器资源，找出异常线索。', '带上一段日志，一起定位问题。', '检查服务状态，把排查步骤理清楚。', '说说你的运维目标，一起安排下一步。'],
  setup: [],
};

/** Decorative conversation signal; never simulates a live task or tool call. */
export function AgentEmptyState({ children, mode = 'general' }: { children: ReactNode; mode?: keyof typeof suggestions }) {
  const container = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(true);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [index, setIndex] = useState(0);
  const [fading, setFading] = useState(false);
  const prompts = suggestions[mode];
  useEffect(() => {
    let visible = false;
    const update = () => setPaused(!visible || document.hidden);
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      update();
    });
    if (container.current) observer.observe(container.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    setIndex(0);
    setFading(false);
    if (paused || reduced || prompts.length < 2) return;
    let exit: ReturnType<typeof setTimeout> | undefined;
    let next: ReturnType<typeof setTimeout> | undefined;
    const cycle = () => {
      exit = setTimeout(() => {
        setFading(true);
        next = setTimeout(() => {
          setIndex(value => (value + 1) % prompts.length);
          setFading(false);
          cycle();
        }, 240);
      }, 4600);
    };
    cycle();
    return () => { clearTimeout(exit); clearTimeout(next); };
  }, [paused, reduced, prompts]);

  return <div ref={container} className="agent-chat-empty agent-signal-empty" data-paused={paused}>
    <div className="agent-conversation-signal" aria-hidden="true">
      <svg viewBox="0 0 220 156" fill="none">
        <path className="agent-signal-guide" d="M28 78h19m126 0h19M110 13v12m0 106v12"/>
        <path className="agent-signal-reply" d="M85 62h65a10 10 0 0 1 10 10v32a10 10 0 0 1-10 10h-12l-16 12v-12H85a10 10 0 0 1-10-10V72a10 10 0 0 1 10-10Z"/>
        <g className="agent-signal-message">
          <path className="agent-signal-bubble" d="M61 36h74a11 11 0 0 1 11 11v39a11 11 0 0 1-11 11H88l-20 15V97h-7a11 11 0 0 1-11-11V47a11 11 0 0 1 11-11Z"/>
          <path className="agent-signal-line" d="M69 57h31m-31 11h49"/>
          <path className="agent-signal-cursor" d="M69 79h17"/>
        </g>
        <path className="agent-signal-spark" d="m164 25 3.5 10.5L178 39l-10.5 3.5L164 53l-3.5-10.5L150 39l10.5-3.5L164 25Z"/>
        <circle className="agent-signal-point is-one" cx="32" cy="112" r="2.5"/>
        <circle className="agent-signal-point is-two" cx="187" cy="88" r="2"/>
        <circle className="agent-signal-point is-three" cx="96" cy="21" r="1.5"/>
      </svg>
    </div>
    <h3>{mode === 'setup' ? '先准备好你的模型' : '从一个问题开始'}</h3>
    {!!prompts.length && <p className={`agent-empty-suggestion${fading ? ' is-leaving' : ''}`} aria-hidden="true"><span key={`${mode}:${index}`}>{prompts[index % prompts.length]}</span></p>}
    <p className="agent-empty-context">{children}</p>
  </div>;
}

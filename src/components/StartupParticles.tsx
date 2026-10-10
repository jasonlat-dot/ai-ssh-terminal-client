import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

type Point = {
  x: number; y: number; vx: number; vy: number; r: number; a: number;
  c: string; phase: number; glow: boolean; trail: boolean;
};
type Dust = { x: number; y: number; r: number; phase: number };
type Burst = { x: number; y: number; vx: number; vy: number; r: number; c: string; life: number };
type Wave = { x: number; y: number; r: number; life: number };
type ParticleEngine = { sync: () => void; burst: () => void };

/** Particle colors, motion and interaction parameters come from the supplied startup demo. */
export function StartupParticles({ enabled, burstVersion, terminalRef }: {
  enabled: boolean;
  burstVersion: number;
  terminalRef: RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enabledRef = useRef(enabled);
  const engineRef = useRef<ParticleEngine | null>(null);
  enabledRef.current = enabled;

  useEffect(() => {
    const canvas = canvasRef.current;
    const main = canvas?.parentElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !main || !context) return;
    const ctx = context;
    let width = 1, height = 1, raf = 0, last = 0, clock = 0, seed = 31;
    let visible = true, disposed = false;
    let points: Point[] = [], dust: Dust[] = [], bursts: Burst[] = [], waves: Wave[] = [];
    const pointer = { x: -1000, y: -1000 };
    const colors = ['86,131,221', '129,99,217', '50,169,193'];
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const dot = (x: number, y: number, r: number, c: string, a: number) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c},${a})`;
      ctx.fill();
    };
    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      clock += dt;
      for (const p of dust) {
        p.y -= dt * 2.5;
        if (p.y < 0) p.y = height;
        dot(p.x, p.y, p.r, '137,151,193', .1 + .16 * (.5 + .5 * Math.sin(clock * .7 + p.phase)));
      }
      for (const p of points) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -20) p.x = width + 20;
        if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        if (p.y > height + 20) p.y = -20;
        const dist = Math.hypot(p.x - pointer.x, p.y - pointer.y);
        const pull = dist < 145 && dist > 1 ? ((145 - dist) / 145) * dt * .12 : 0;
        p.x += (pointer.x - p.x) * pull;
        p.y += (pointer.y - p.y) * pull;
        const a = p.a * (.67 + .33 * Math.sin(clock * .8 + p.phase) ** 2);
        if (p.glow) {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 9);
          g.addColorStop(0, `rgba(${p.c},${a * .33})`);
          g.addColorStop(1, `rgba(${p.c},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(p.x - 9, p.y - 9, 18, 18);
        }
        if (p.trail) {
          const tx = p.x - p.vx * 3, ty = p.y - p.vy * 3;
          const g = ctx.createLinearGradient(tx, ty, p.x, p.y);
          g.addColorStop(0, `rgba(${p.c},0)`);
          g.addColorStop(1, `rgba(${p.c},${a * .38})`);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = g;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        dot(p.x, p.y, p.r, p.c, a);
        if (p.glow) {
          const t = .5 + .5 * Math.sin(clock * .7 + p.phase);
          ctx.strokeStyle = `rgba(${p.c},${t * a * .35})`;
          ctx.lineWidth = .6;
          ctx.beginPath();
          ctx.moveTo(p.x - 4, p.y);
          ctx.lineTo(p.x + 4, p.y);
          ctx.moveTo(p.x, p.y - 4);
          ctx.lineTo(p.x, p.y + 4);
          ctx.stroke();
        }
      }
      for (let i = 0; i < points.length; i++) {
        let links = 0;
        const a = points[i];
        for (let j = i + 1; j < points.length && links < 3; j++) {
          const b = points[j], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 88) {
            links++;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.lineWidth = .55;
            ctx.strokeStyle = `rgba(108,132,204,${(1 - d / 88) * .2})`;
            ctx.stroke();
          }
        }
      }
      const cx = width * .76, cy = height * .45;
      const rx = Math.min(width * .2, 183), ry = height * .34;
      if (width > 650) {
        for (let j = 0; j < 7; j++) {
          const angle = clock * .045 + j * Math.PI * 2 / 7;
          dot(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry, 1.7, colors[j % 3], .48);
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, angle - .13, angle);
          ctx.strokeStyle = `rgba(${colors[j % 3]},.13)`;
          ctx.lineWidth = .8;
          ctx.stroke();
        }
      }
      bursts = bursts.filter(b => b.life > 0);
      for (const b of bursts) {
        b.life -= dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.vx *= 1 - dt * .55;
        b.vy *= 1 - dt * .55;
        dot(b.x, b.y, b.r, b.c, Math.max(0, b.life / 1.7) * .65);
      }
      waves = waves.filter(w => w.life > 0);
      for (const w of waves) {
        w.life -= dt;
        w.r += dt * 65;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(124,132,231,${Math.max(0, w.life / 1.8) * .18})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };
    const resize = () => {
      const rect = main.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed = 31;
      points = Array.from({ length: width < 600 ? 55 : 106 }, (_, i) => ({
        x: rand() * width, y: rand() * height, vx: (rand() - .5) * 13, vy: (rand() - .5) * 12,
        r: .8 + rand() * 1.5, a: .22 + rand() * .3, c: colors[Math.floor(rand() * 3)],
        phase: rand() * Math.PI * 2, glow: i % 9 === 0, trail: i % 14 === 0,
      }));
      dust = Array.from({ length: width < 600 ? 30 : 65 }, () => ({
        x: rand() * width, y: rand() * height, r: .4 + rand() * .6, phase: rand() * Math.PI * 2,
      }));
      draw(0);
    };
    const frame = (now: number) => {
      raf = 0;
      if (disposed || !main.isConnected || document.hidden || !visible || !enabledRef.current) return;
      if (now - last >= 32) {
        const dt = Math.min((now - last) / 1000, .05);
        last = now;
        draw(dt);
      }
      raf = requestAnimationFrame(frame);
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = performance.now();
      if (enabledRef.current && visible && !document.hidden) raf = requestAnimationFrame(frame);
      else draw(0);
    };
    const burst = () => {
      const terminal = terminalRef.current;
      if (!enabledRef.current || !terminal) return;
      const rect = main.getBoundingClientRect(), b = terminal.getBoundingClientRect();
      const x = b.left - rect.left + b.width / 2, y = b.top - rect.top + b.height / 2;
      for (let i = 0; i < 46; i++) {
        const angle = rand() * Math.PI * 2, speed = 35 + rand() * 75;
        bursts.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          r: 1 + rand(), c: colors[i % 3], life: 1.7 });
      }
      waves.push({ x, y, r: 35, life: 1.8 });
    };
    const movePointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const b = main.getBoundingClientRect();
      pointer.x = event.clientX - b.left;
      pointer.y = event.clientY - b.top;
    };
    const clearPointer = () => { pointer.x = pointer.y = -1000; };
    const engine = { sync, burst };
    engineRef.current = engine;
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      sync();
    });
    main.addEventListener('pointermove', movePointer);
    main.addEventListener('pointerleave', clearPointer);
    document.addEventListener('visibilitychange', sync);
    resizeObserver.observe(main);
    intersectionObserver.observe(main);
    resize();
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      main.removeEventListener('pointermove', movePointer);
      main.removeEventListener('pointerleave', clearPointer);
      document.removeEventListener('visibilitychange', sync);
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [terminalRef]);

  useEffect(() => { engineRef.current?.sync(); }, [enabled]);
  useEffect(() => { if (burstVersion > 0) engineRef.current?.burst(); }, [burstVersion]);
  return <canvas ref={canvasRef} className="startup-particle-field" aria-hidden="true" />;
}

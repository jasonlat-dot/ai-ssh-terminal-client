import assert from 'node:assert/strict';
import test from 'node:test';
import { beginFilePointerDrag } from '../src/state/filePointerDrag';

function fixture() {
  const listeners = new Map<string, (event: any) => void>(), windowListeners = new Map<string, () => void>();
  const row = {}, remoteChild = {}, overlay = {};
  let hit: object | null = row, uploaded = 0, captured = 0, released = 0;
  const classes = new Set<string>(), hovered: boolean[] = [];
  const doc = {
    elementFromPoint: () => hit,
    documentElement: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
    addEventListener: (type: string, listener: any) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    defaultView: { addEventListener: (type: string, listener: any) => windowListeners.set(type, listener), removeEventListener: (type: string) => windowListeners.delete(type) },
  } as unknown as Document;
  const source = { setPointerCapture: () => captured++, releasePointerCapture: () => released++ } as unknown as HTMLElement;
  const start = { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 10, clientY: 10 } as PointerEvent;
  const begin = (patch = {}) => beginFilePointerDrag({ ...start, ...patch } as PointerEvent, source, {
    document: doc, target: () => ({ contains: node => node === remoteChild }) as HTMLElement,
    hover: active => hovered.push(active), drop: () => uploaded++,
  });
  const emit = (type: string, patch = {}) => listeners.get(type)?.({ ...start, clientX: 100, clientY: 100, preventDefault() {}, ...patch });
  return { begin, emit, listeners, windowListeners, hovered, classes, remoteChild, overlay, hit: (node: object | null) => { hit = node; },
    count: () => ({ uploaded, captured, released }) };
}

test('pointer upload works without HTML5 events and submits exactly once over remote pane', () => {
  const f = fixture(); f.begin(); f.hit(f.remoteChild); f.emit('pointermove');
  assert.equal(f.hovered.at(-1), true); assert.equal(f.classes.has('file-pointer-dragging'), true);
  f.emit('pointerup'); f.emit('pointerup');
  assert.deepEqual(f.count(), { uploaded: 1, captured: 1, released: 1 });
  assert.equal(f.classes.size, 0); assert.equal(f.listeners.size, 0); assert.equal(f.windowListeners.size, 0);
});

test('clicks, another pointer and modal overlays cannot upload', () => {
  const click = fixture(); click.begin(); click.hit(click.remoteChild); click.emit('pointermove', { clientX: 12, clientY: 12 }); click.emit('pointerup');
  assert.equal(click.count().uploaded, 0);
  const other = fixture(); const cancel = other.begin(); other.hit(other.remoteChild); other.emit('pointermove', { pointerId: 2 }); other.emit('pointerup', { pointerId: 2 });
  assert.equal(other.count().uploaded, 0); cancel();
  const modal = fixture(); modal.begin(); modal.hit(modal.overlay); modal.emit('pointermove'); modal.emit('pointerup'); assert.equal(modal.count().uploaded, 0);
});

test('Escape, loss of focus, pointer cancellation and unmount release the drag without upload', () => {
  for (const method of ['escape', 'blur', 'pointercancel', 'unmount']) {
    const f = fixture(), cancel = f.begin(); f.hit(f.remoteChild); f.emit('pointermove');
    if (method === 'escape') f.emit('keydown', { key: 'Escape' });
    else if (method === 'blur') f.windowListeners.get('blur')?.();
    else if (method === 'pointercancel') f.emit('pointercancel');
    else cancel();
    assert.equal(f.count().uploaded, 0); assert.equal(f.count().released, 1); assert.equal(f.listeners.size, 0);
  }
  for (const patch of [{ button: 2 }, { pointerType: 'touch' }, { isPrimary: false }]) {
    const f = fixture(); f.begin(patch); assert.equal(f.listeners.size, 0);
  }
});

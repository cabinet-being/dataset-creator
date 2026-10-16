import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ExplorerPanel } from '../src/components/workspace/ExplorerPanel';

export async function checkExplorerMarquee(): Promise<string> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:20px;top:20px;width:240px;height:180px;display:flex;z-index:99999;background:white';
  document.body.append(host);
  const root = createRoot(host);
  let selected: string[] = ['seed']; let calls = 0; let captured = false;
  function Fixture() {
    const panel = useRef<HTMLDivElement>(null);
    const [paths, setPaths] = useState(new Set(['seed']));
    return <ExplorerPanel panelRef={panel} error={null} selectedPaths={paths}
      onSelectionChange={next => { selected = next; calls++; setPaths(new Set(next)); }}
      onDismissContextMenu={() => {}} onRootContextMenu={() => {}} onDropTargetChange={() => {}} onDropFiles={() => {}}>
      {Array.from({length:30}, (_, i) => <div key={i} data-explorer-row data-explorer-path={`row-${i}`} style={{height:24,marginLeft:12}}>Row {i}</div>)}
    </ExplorerPanel>;
  }
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  try {
    flushSync(() => root.render(<Fixture />));
    const panel = host.firstElementChild as HTMLDivElement;
    panel.setPointerCapture = () => { captured = true; };
    panel.hasPointerCapture = () => captured;
    panel.releasePointerCapture = () => { captured = false; };
    const bounds = panel.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number, ctrlKey = false) => flushSync(() => {
      panel.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,button:0,clientX:bounds.left+x,clientY:bounds.top+y,ctrlKey}));
    });
    const resetScroll = () => { panel.scrollTop = 0; };
    const start = (additive = false) => { resetScroll(); pointer('pointerdown',2,40,additive); pointer('pointermove',150,90,additive); };
    start(); await frame(); await frame();
    assert(selected.includes('row-2') && captured,'Inline parent callbacks must not cancel the gesture');
    const count = calls; await frame(); await frame();
    assert(calls === count,'A stationary frame must not emit duplicate selections');
    pointer('pointerup',150,135);
    assert(selected.includes('row-4') && !captured,'Pointerup flushes its final position and releases capture');
    const previous = [...selected].sort().join('|');
    for (const cancel of ['Escape','blur','pointercancel','lostpointercapture']) {
      start(); await frame();
      flushSync(() => {
        if (cancel === 'Escape') panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        else if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
        else panel.dispatchEvent(new PointerEvent(cancel,{bubbles:true,pointerId:1}));
      });
      assert(selected.slice().sort().join('|') === previous && !captured,`${cancel} restores selection and releases capture`);
    }
    start(true); pointer('pointermove',150,200,true);
    for (let i=0;i<12;i++) await frame();
    assert(panel.scrollTop > 0,'Holding the pointer beyond the bottom edge must scroll Explorer');
    pointer('pointerup',150,200,true);
    assert(previous.split('|').every(path=>selected.includes(path)),'Ctrl selection preserves previous rows during scrolling');
    start(); await frame(); flushSync(() => root.unmount());
    assert(!captured,'Unmount releases pointer capture');
    return 'PASS: parent rerenders, unchanged selection, final pointer position, Escape/blur/cancel/lost capture, Ctrl selection, edge scrolling and unmount.';
  } finally {
    root.unmount(); host.remove();
  }
}

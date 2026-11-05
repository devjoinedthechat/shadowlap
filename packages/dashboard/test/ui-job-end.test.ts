import { act, createElement, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../ui/components/Dialog.js';
import { MenuItem, Popover, useMenu } from '../ui/components/Popover.js';
import { handOnAtEnd, notingJobFrom } from '../ui/focus-manager.js';
import { OverlaySlots } from '../ui/overlays/slots.js';
import { useRoute } from '../ui/router.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { AppContext } from '../ui/state.js';
import { addressBar, app, watchThePage } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Where the focus goes when the page draws anew under it: to what took the place of the control that
 * had it, found again by what it is; and, a job having ended, to the step that took the place of the
 * control that started it, however long after the job's end the page takes it away.
 */

let r: Rendered | null = null;
beforeAll(() => {
  // No layout here: a menu is placed against a window of this size.
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});
beforeEach(() => {
  addressBar('#/runs');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('what is drawn anew', () => {
  /** A page that draws a control anew at each step within it, as a run's view does. */
  function Step() {
    const route = useRoute();
    return createElement('div', { id: 'app' }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', {}, 'A run'), createElement('button', { type: 'button', id: 'other' }, 'Other'), createElement('button', { type: 'button', key: route.page === 'run' ? route.call : 0, id: 'kept' }, 'Kept')));
  }

  it('hands the focus to its counterpart', async () => {
    addressBar('#/run/A/1');
    r = await render(createElement(Step));
    const first = r.one('#kept');
    await r.focus(first);
    await act(async () => void (location.hash = '#/run/A/2'));
    expect(r.one('#kept')).not.toBe(first);
    expect(r.focused()).toBe(r.one('#kept'));
  });

  it('leaves a move you made yourself where it is', async () => {
    addressBar('#/run/A/1');
    r = await render(createElement(Step));
    await r.focus(r.one('#kept'));
    await r.focus(r.one('#other'));
    await act(async () => void (location.hash = '#/run/A/2'));
    expect(r.focused().getAttribute('id')).toBe('other');
  });
});

describe('a job’s end', () => {
  // Each as the app has it: `handOnAtEnd` as the job ends, and the page drawn after it, once it has read the run again.
  const tick = (ms = 80) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
  /** A section whose button started a job; what the job's end draws in its place comes with `after`, a second step with `again`. */
  function Part({ after }: { after: false | true | 'again' }) {
    const step = after === 'again' ? 'next' : 'step';
    return createElement(
      'main',
      { id: 'view' },
      createElement('button', { type: 'button', id: 'elsewhere' }, 'Elsewhere'),
      createElement('section', { id: 'part' }, after ? createElement('button', { type: 'button', key: step, className: 'btn lime', id: step }, 'Revert') : createElement('button', { type: 'button', key: 'start', className: 'btn', id: 'start' }, 'Find it')),
    );
  }
  function Shown() {
    useRoute();
    const [after, setAfter] = useState<false | true | 'again'>(false);
    ended = setAfter;
    return createElement(Part, { after });
  }
  let ended!: (on: true | 'again') => void;

  it('hands the focus on to the step that took the control’s place in its part of the page', async () => {
    r = await render(createElement(Shown));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-1' }));
    handOnAtEnd('job-1');
    await act(async () => ended(true));
    await tick();
    expect(r.focused().getAttribute('id')).toBe('step');
  });

  it('waits for a control the page takes away well after the job’s end, and for what takes its place', async () => {
    const changed = watchThePage();
    r = await render(createElement(Shown));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-5' }));
    handOnAtEnd('job-5');
    await tick();
    expect(r.focused().getAttribute('id')).toBe('start');
    await act(async () => ended(true));
    await changed();
    expect(r.focused().getAttribute('id')).toBe('step');
    // That step going too, with a later draw, hands on again.
    await act(async () => ended('again'));
    await changed();
    expect(r.focused().getAttribute('id')).toBe('next');
  });

  it('hands on from a counterpart the page drew anew first, then took away', async () => {
    const changed = watchThePage();
    function Anew() {
      useRoute();
      const [at, setAt] = useState<'one' | 'two' | 'gone'>('one');
      setStage = setAt;
      return createElement(
        'div',
        { id: 'app' },
        createElement('main', { id: 'view' }, createElement('section', { id: 'part' }, at === 'gone' ? createElement('button', { type: 'button', key: 'step', className: 'btn lime', id: 'step' }, 'Revert') : createElement('button', { type: 'button', className: 'btn', key: at, id: 'start' }, 'Find it'))),
      );
    }
    let setStage!: (at: 'one' | 'two' | 'gone') => void;
    r = await render(createElement(Anew));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-9' }));
    handOnAtEnd('job-9');
    await tick();
    await act(async () => setStage('two'));
    await changed();
    expect(r.focused()).toBe(r.one('#start'));
    await act(async () => setStage('gone'));
    await changed();
    expect(r.focused().getAttribute('id')).toBe('step');
  });

  /** A control that asks first, or opens a menu, as most jobs do: the job starts from the dialog or the menu, beside the page. */
  function Asks({ menu }: { menu: boolean }) {
    useRoute();
    const m = useMenu();
    const [asked, setAsked] = useState(false);
    const [after, setAfter] = useState(false);
    ended = () => setAfter(true);
    answered = () => {
      setAsked(false);
      m.close();
    };
    const control = createElement('button', { type: 'button', key: 'start', className: 'btn', id: 'start', onClick: (e: { currentTarget: HTMLElement }) => (menu ? m.toggle(e.currentTarget) : setAsked(true)) }, 'Find it');
    return createElement(
      AppContext.Provider,
      { value: app() },
      createElement(
        'div',
        { id: 'app' },
        createElement('main', { id: 'view' }, createElement('section', { id: 'part' }, after ? createElement('button', { type: 'button', key: 'step', className: 'btn lime', id: 'step' }, 'Revert') : control)),
        createElement('div', { className: 'drawer' }, createElement('pre', { id: 'jout', tabIndex: 0 }, 'output')),
      ),
      asked ? createElement(Dialog, { title: 'Find it', ok: 'Find it', onOk: () => setAsked(false), onClose: () => setAsked(false) }) : null,
      m.open && m.anchor ? createElement(Popover, { anchor: m.anchor, onClose: m.close, label: 'Find it', children: [createElement(MenuItem, { key: 'go', label: 'Go', onPick: m.close })] }) : null,
      createElement(OverlaySlots),
      createElement(Keyboard),
    );
  }
  let answered!: () => void;

  it('reads the part of the page from what opened the dialog a job starts from, its OK having the focus', async () => {
    r = await render(createElement(Asks, { menu: false }));
    await r.click(r.one('#start'));
    expect(r.focused().closest('#layer')).not.toBeNull();
    await notingJobFrom(Promise.resolve({ id: 'job-6' }));
    await act(async () => answered());
    expect(r.focused().getAttribute('id')).toBe('start');
    handOnAtEnd('job-6');
    await act(async () => ended(true));
    await tick();
    expect(r.focused().getAttribute('id')).toBe('step');
  });

  it('reads it from what opened the menu a job starts from, its item having the focus', async () => {
    r = await render(createElement(Asks, { menu: true }));
    await r.click(r.one('#start'));
    await r.until('the menu to take the focus', () => r!.focused().textContent === 'Go');
    expect(r.focused().closest('#menu')).not.toBeNull();
    await notingJobFrom(Promise.resolve({ id: 'job-7' }));
    await act(async () => answered());
    expect(r.focused().getAttribute('id')).toBe('start');
    handOnAtEnd('job-7');
    await act(async () => ended(true));
    await tick();
    expect(r.focused().getAttribute('id')).toBe('step');
  });

  it('takes nothing from under a dialog, and asks nothing once it closes', async () => {
    const changed = watchThePage();
    r = await render(createElement(Asks, { menu: false }));
    await r.click(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-8' }));
    handOnAtEnd('job-8');
    await tick();
    expect(r.focused().closest('#layer')).not.toBeNull();
    await act(async () => answered());
    await act(async () => ended(true));
    await changed();
    expect(r.focused().tagName).not.toBe('BUTTON');
  });

  it('counts only the opener’s own part as the head’s: a verdict further down is no head', async () => {
    function Head() {
      useRoute();
      return createElement(
        'main',
        { id: 'view' },
        createElement('div', { className: 'page-in' }, createElement('div', { className: 'verdict', id: 'head' }, createElement('button', { type: 'button', className: 'btn', id: 'top' }, 'Top')), createElement('div', {}, createElement('div', { className: 'verdict gv' }, createElement('button', { type: 'button', className: 'btn', id: 'low' }, 'Low'), createElement('button', { type: 'button', className: 'btn lime', id: 'lime' }, 'A lime lower down')))),
        createElement('div', { className: 'drawer' }, createElement('pre', { id: 'jout', tabIndex: 0 }, 'output')),
      );
    }
    r = await render(createElement(Head));
    await r.focus(r.one('#low'));
    await notingJobFrom(Promise.resolve({ id: 'job-10' }));
    r.focused().blur();
    handOnAtEnd('job-10');
    await tick();
    expect(r.focused().getAttribute('id')).toBe('jout');
  });

  it('hands it to the drawer where nothing took the control’s place, at the last look: its way on, else its log', async () => {
    vi.useFakeTimers();
    function Gone({ lime }: { lime: boolean }) {
      useRoute();
      const [after, setAfter] = useState(false);
      ended = () => setAfter(true);
      return createElement(
        'div',
        {},
        createElement('main', { id: 'view' }, createElement('section', { id: 'part' }, after ? null : createElement('button', { type: 'button', className: 'btn', id: 'start' }, 'Verify'))),
        createElement('div', { className: 'drawer' }, createElement('pre', { id: 'jout', tabIndex: 0 }, 'output'), lime ? createElement('div', { className: 'jfoot' }, createElement('span', { className: 'jkind' }, createElement('button', { type: 'button', className: 'btn lime', id: 'on' }, 'Run test'))) : null),
      );
    }
    r = await render(createElement(Gone, { lime: true }));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-3' }));
    handOnAtEnd('job-3');
    await act(async () => ended(true));
    await r.wait(100);
    // The page may yet draw a step.
    expect(r.focused().tagName).toBe('BODY');
    await r.wait(3000);
    expect(r.focused().getAttribute('id')).toBe('on');
    await r.unmount();
    r = await render(createElement(Gone, { lime: false }));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-4' }));
    handOnAtEnd('job-4');
    await act(async () => ended(true));
    await r.wait(3100);
    expect(r.focused().getAttribute('id')).toBe('jout');
  });

  it('hands it to the drawer at once where the job started from no part of the page', async () => {
    function Beside() {
      useRoute();
      return createElement('div', {}, createElement('main', { id: 'view' }, createElement('section', { id: 'part' }, createElement('button', { type: 'button', className: 'btn', id: 'start' }, 'Find it'))), createElement('div', { className: 'drawer' }, createElement('pre', { id: 'jout', tabIndex: 0 }, 'output')));
    }
    r = await render(createElement(Beside));
    await notingJobFrom(Promise.resolve({ id: 'job-11' }));
    handOnAtEnd('job-11');
    await tick();
    expect(r.focused().getAttribute('id')).toBe('jout');
  });

  it('leaves the focus where you moved it, before the job’s end', async () => {
    r = await render(createElement(Shown));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-2' }));
    await r.focus(r.one('#elsewhere'));
    handOnAtEnd('job-2');
    await act(async () => ended(true));
    await tick();
    expect(r.focused().getAttribute('id')).toBe('elsewhere');
  });

  it('leaves it where you moved it while it waits, a Tab or a click beside the control', async () => {
    const changed = watchThePage();
    r = await render(createElement(Shown));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-12' }));
    handOnAtEnd('job-12');
    await tick();
    await r.focus(r.one('#elsewhere'));
    await act(async () => ended(true));
    await changed();
    expect(r.focused().getAttribute('id')).toBe('elsewhere');
    await r.unmount();
    r = await render(createElement(Shown));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-13' }));
    handOnAtEnd('job-13');
    await tick();
    r.focused().blur();
    await changed();
    await act(async () => ended(true));
    await changed();
    expect(r.focused().tagName).toBe('BODY');
  });

  it('stops waiting on another page', async () => {
    const changed = watchThePage();
    r = await render(createElement(Shown));
    await r.focus(r.one('#start'));
    await notingJobFrom(Promise.resolve({ id: 'job-14' }));
    handOnAtEnd('job-14');
    await tick();
    await act(async () => void (location.hash = '#/fixes'));
    await act(async () => ended(true));
    await changed();
    expect(r.all('#step')).toHaveLength(1);
    expect(r.focused().getAttribute('id')).not.toBe('step');
  });
});

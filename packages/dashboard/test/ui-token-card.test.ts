import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pastedLink } from '../ui/connection.js';
import { ExpiredCard, Gate } from '../ui/shell/Connection.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A link whose session token the dashboard refuses read "This link has expired · The dashboard was
 * restarted", whatever the cause: a link from another dashboard got the same words. The card now
 * says the token isn't this dashboard's, from a restart or another dashboard, and Paste the new link
 * opens the link the dashboard printed, from the clipboard, on this machine only.
 */

const HERE = 'http://127.0.0.1:4777';

describe('a pasted dashboard link', () => {
  it('opens the same server by its fragment, and another port by the whole link', () => {
    expect(pastedLink(`${HERE}/#token=newtoken_1&open=/runs`, HERE)).toEqual({ kind: 'hash', hash: '#token=newtoken_1&open=/runs' });
    expect(pastedLink(`  ${HERE}/#token=abc-DEF  \n`, HERE)).toEqual({ kind: 'hash', hash: '#token=abc-DEF' });
    expect(pastedLink('http://127.0.0.1:4790/#token=abc', HERE)).toEqual({ kind: 'go', url: 'http://127.0.0.1:4790/#token=abc' });
    expect(pastedLink('http://localhost:4777/#token=abc', HERE)).toEqual({ kind: 'go', url: 'http://localhost:4777/#token=abc' });
    expect(pastedLink('http://[::1]:4777/#token=abc', HERE)).toEqual({ kind: 'go', url: 'http://[::1]:4777/#token=abc' });
  });

  it('never leaves this machine, and takes only a link that carries a token', () => {
    for (const text of ['https://evil.example/#token=abc', 'http://10.0.0.5:4777/#token=abc', 'http://user:pw@127.0.0.1:4777/#token=abc', `${HERE}/`, `${HERE}/#/runs`, 'shadowlap dashboard', '#token=abc', 'javascript:alert(1)//#token=abc', '', `${HERE}/#token=abc and more`])
      expect(pastedLink(text, HERE), text).toBeNull();
  });
});

describe('the card for a refused session token', () => {
  let r: Rendered | null = null;
  const location = { origin: HERE, hash: '#/runs', assign: vi.fn() };
  afterEach(async () => {
    await r?.unmount();
    r = null;
    vi.unstubAllGlobals();
    location.hash = '#/runs';
    location.assign.mockReset();
  });

  async function card(clipboard: () => Promise<string>): Promise<Rendered> {
    vi.stubGlobal('location', location);
    vi.stubGlobal('navigator', { clipboard: { readText: clipboard } });
    return render(createElement(AppContext.Provider, { value: { conn: 'expired', toast: () => undefined } as unknown as AppState }, createElement(ExpiredCard)));
  }

  it('says the token isn’t this dashboard’s, from a restart or another dashboard', async () => {
    r = await card(async () => '');
    expect(r.one('#connT').textContent).toBe('This link’s session token isn’t this dashboard’s');
    expect(r.one('#connD').textContent.replace(/\u00a0/g, ' ')).toBe('It was restarted, or the link is from another one. Open the link it printed when it started, or start it again:');
    expect(r.one('.connblock').getAttribute('aria-describedby')).toBe('connD');
    // One command box, with its own Copy, and the card's one lime way out.
    expect(r.one('.cb .cmdline').textContent).toContain('shadowlap dashboard');
    expect(r.all('.cb .actions button').map((b) => b.textContent)).toEqual(['Paste the new link']);
    expect(r.one('.cb .cbdoc a').getAttribute('href')).toBe('https://github.com/devjoinedthechat/shadowlap/blob/main/docs/dashboard.md#security-and-consent');
  });

  it('opens the new link from the clipboard: its fragment here, the whole link on another port', async () => {
    r = await card(async () => `${HERE}/#token=fresh_token&open=/tests`);
    await r.click(r.byText('.cb .actions button', 'Paste the new link'));
    await r.until('the page to take the link', () => location.hash === '#token=fresh_token&open=/tests');
    await r.unmount();
    r = await card(async () => 'http://127.0.0.1:4790/#token=fresh_token');
    await r.click(r.byText('.cb .actions button', 'Paste the new link'));
    await r.until('the page to go', () => location.assign.mock.calls.length > 0);
    expect(location.assign).toHaveBeenCalledWith('http://127.0.0.1:4790/#token=fresh_token');
  });

  it('says why when the clipboard holds no dashboard link, or can’t be read', async () => {
    r = await card(async () => 'https://example.com/#token=abc');
    await r.click(r.byText('.cb .actions button', 'Paste the new link'));
    await r.until('the reason', () => r!.all('.cb .fieldnote').length > 0);
    expect(r.one('.cb .fieldnote').textContent).toContain('holds no dashboard link');
    expect(location.hash).toBe('#/runs');
    await r.unmount();
    r = await card(() => Promise.reject(new Error('denied')));
    await r.click(r.byText('.cb .actions button', 'Paste the new link'));
    await r.until('the reason', () => r!.all('.cb .fieldnote').length > 0);
    expect(r.one('.cb .fieldnote').textContent).toContain('paste the link into the address bar');
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('says why a paste is refused as an alert from a region there since the card came, again on each press, the line drawn for the eye only', async () => {
    let answer: (text: string) => void = () => undefined;
    r = await card(() => new Promise<string>((resolve) => (answer = resolve)));
    // Before a press, the card's alert region is there, empty.
    const region = r.one('.cb .said > [role="alert"]');
    expect(region.textContent).toBe('');
    const refused = 'The clipboard holds no dashboard link: copy the one shadowlap dashboard printed, with its #token=.';
    await r.click(r.byText('.cb .actions button', 'Paste the new link'));
    answer('https://example.com/#token=abc');
    await r.until('the reason', () => region.textContent !== '');
    expect([r.one('.cb .said > [role="alert"]') === region, region.textContent]).toEqual([true, refused]);
    const drawn = r.one('.cb .fieldnote');
    expect([drawn.textContent, drawn.getAttribute('aria-hidden'), drawn.hasAttribute('role')]).toEqual([refused, 'true', false]);
    // Pressed again, the reason goes while the clipboard is read and comes back, so it is said again.
    await r.click(r.byText('.cb .actions button', 'Paste the new link'));
    expect([region.textContent, r.all('.cb .fieldnote').length]).toEqual(['', 0]);
    answer('https://example.com/#token=abc');
    await r.until('the reason again', () => region.textContent !== '');
    expect([r.one('.cb .said > [role="alert"]') === region, region.textContent]).toEqual([true, refused]);
  });
});

describe('the token gate’s Copy', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Outside the app no toast can come from, and asking for one would throw (useApp outside
  // AppProvider): the gate, drawn with no provider, says what its Copy did on the button itself.
  it('says Copied on its button for 1.6 s, then goes back, and Copy failed where the browser refuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
    r = await render(createElement(Gate));
    const copy = () => r!.one('.gate .cmdline button.boxcopy');
    const said = () => [copy().textContent, copy().getAttribute('aria-label')];
    expect(said()).toEqual(['', 'Copy command']);
    await r.click(copy());
    await r.wait(0);
    expect(writes).toEqual(['shadowlap dashboard']);
    expect(said()).toEqual(['Copied', 'Copied']);
    await r.wait(1599);
    expect(said()).toEqual(['Copied', 'Copied']);
    await r.wait(1);
    expect(said()).toEqual(['', 'Copy command']);
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    await r.click(copy());
    await r.wait(0);
    expect(said()).toEqual(['Copy failed', 'Copy failed']);
    await r.wait(1600);
    expect(said()).toEqual(['', 'Copy command']);
  });
});

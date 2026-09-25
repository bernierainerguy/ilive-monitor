import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Logger } from '@main/logging/Logger';
import { EULA_VERSION, LegalService } from '@main/services/LegalService';
import { GRACE_MS, LicenceService, emptyLicenceState, type LicenceState } from '@main/services/LicenceService';
import { useAppStore } from '@renderer/state/appStore';
import { bootApp } from '../helpers/renderApp';

vi.mock('electron', () => import('../helpers/electronMock'));

const DAY = 86_400_000;
let dir: string;
let stop: (() => Promise<void>) | null = null;
let replies: Array<() => Promise<Response>>;
const fetchFn = vi.fn(async () => (replies.shift() ?? (async () => new Response(JSON.stringify({ status: 'granted' }))))());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ilive-ui-lic-'));
  replies = [];
  fetchFn.mockClear();
});
afterEach(async () => {
  await stop?.();
  stop = null;
  rmSync(dir, { recursive: true, force: true });
});

const registered = (p: Partial<LicenceState>): LicenceState => ({
  ...emptyLicenceState(), uuid: 'abcdef12-0000-4000-8000-000000000000', name: 'Op', email: 'op@example.com', machineName: 'FOH', ...p,
});

async function boot(opts: { eula?: boolean; state?: LicenceState; path?: string } = {}) {
  if (opts.eula !== false) writeFileSync(join(dir, 'eula.json'), JSON.stringify({ version: EULA_VERSION, acceptedAt: '2026-09-24T10:00:00.000Z' }));
  if (opts.state) writeFileSync(join(dir, 'licence.json'), JSON.stringify(opts.state));
  const log = new Logger('error');
  const legal = new LegalService(join(dir, 'eula.json'), log);
  await legal.init();
  const licence = new LicenceService({
    statePath: join(dir, 'licence.json'), version: '0.5.1', hostname: 'Studio-Mac', log, fetch: fetchFn as unknown as typeof fetch, showMode: () => false,
  });
  await licence.init();
  const quit = vi.fn();
  const app = await bootApp(opts.path ?? '/mix', { legal, licence, quit });
  stop = app.stop;
  return { ...app, legal, licence, quit };
}

const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('first run', () => {
  it('asks for the EULA, then registration, then gets out of the way', async () => {
    await boot({ eula: false });
    const eula = await screen.findByRole('dialog', { name: 'Licence agreement' });
    expect(within(eula).getByText(/not affiliated with, endorsed by/)).toBeInTheDocument();
    expect(within(eula).getByText('Your equipment')).toBeInTheDocument(); // privacy notice shown too
    expect(within(eula).getByText(`Version ${EULA_VERSION}. Declining quits iLive Monitor.`)).toBeInTheDocument();
    fireEvent.click(within(eula).getByRole('button', { name: 'Accept' }));

    const reg = await screen.findByRole('dialog', { name: 'Register iLive Monitor' });
    expect(field('Computer name').value).toBe('Studio-Mac');
    expect(field('Computer name')).toBeDisabled(); // comes from macOS, not the operator
    fireEvent.click(within(reg).getByRole('button', { name: 'Register' }));
    expect(await within(reg).findByText('Required')).toBeInTheDocument();
    expect(within(reg).getByText('Enter a valid email address')).toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalled();

    type(field('Your name'), 'Sam Operator');
    type(field('Email'), 'sam@example.com');
    fireEvent.click(within(reg).getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().licence).toMatchObject({ reason: 'granted', identity: { name: 'Sam Operator', machineName: 'Studio-Mac' } });
    expect(screen.getByRole('heading', { name: 'Choose your mix' })).toBeInTheDocument();
  });

  it('declining the EULA quits', async () => {
    const { quit } = await boot({ eula: false });
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Licence agreement' })).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(quit).toHaveBeenCalled());
  });

  it('a registration the server refuses shows the error', async () => {
    await boot();
    const reg = await screen.findByRole('dialog', { name: 'Register iLive Monitor' });
    replies.push(async () => new Response(JSON.stringify({ status: 'denied', denied_reason: 'Not for resale' })));
    type(field('Your name'), 'Sam');
    type(field('Email'), 'sam@example.com');
    fireEvent.click(within(reg).getByRole('button', { name: 'Register' }));
    const blocked = await screen.findByRole('dialog', { name: 'This installation is not licensed' });
    expect(within(blocked).getByText('Not for resale')).toBeInTheDocument();
  });
});

describe('launch gate', () => {
  it('blocks a lapsed launch until Retry checks in', async () => {
    const lapsed = registered({ status: 'granted', lastCheckinAt: new Date(Date.now() - 40 * DAY).toISOString(), graceUntil: new Date(Date.now() - 10 * DAY).toISOString(), lastError: 'offline' });
    await boot({ state: lapsed });
    const d = await screen.findByRole('dialog', { name: 'Licence check-in needed' });
    expect(within(d).getByText('Last attempt: offline')).toBeInTheDocument();
    expect(within(d).getByText(/installation abcdef12/)).toBeInTheDocument();
    replies.push(async () => { throw new Error('still offline'); });
    fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
    expect(await within(d).findByText('Last attempt: still offline')).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

});

describe('while running', () => {
  it('a denial is only a dismissible notice; the app carries on', async () => {
    const ok = registered({ status: 'granted', lastCheckinAt: new Date().toISOString(), graceUntil: new Date(Date.now() + GRACE_MS).toISOString() });
    const { licence } = await boot({ state: ok });
    await screen.findByRole('heading', { name: 'Choose your mix' });
    replies.push(async () => new Response(JSON.stringify({ status: 'denied', denied_reason: 'Refunded' })));
    await act(async () => void (await licence.checkin()));
    const notice = await screen.findByText(/withdrawn this installation.s licence \(Refunded\)/);
    expect(notice).toHaveTextContent('won’t start next time'.replace('’', "'"));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(within(notice.closest('[role=alert]') as HTMLElement).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/withdrawn this installation/)).not.toBeInTheDocument();
  });

  it('warns in the last week of grace and checks in from the banner', async () => {
    const soon = registered({ status: 'granted', lastCheckinAt: new Date(Date.now() - 27 * DAY).toISOString(), graceUntil: new Date(Date.now() + 3 * DAY - 1000).toISOString() });
    replies.push(async () => { throw new Error('offline'); }); // the boot check-in isn't run by the test backend; this serves the click
    await boot({ state: soon });
    const banner = await screen.findByText(/Licence check-in expires in 3 days/);
    fireEvent.click(within(banner.closest('[role=alert]') as HTMLElement).getByRole('button', { name: 'Check in now' }));
    await waitFor(() => expect(useAppStore.getState().licence).toMatchObject({ checking: false, lastError: 'offline' }));
    fireEvent.click(within((await screen.findByText(/expires in 3 days/)).closest('[role=alert]') as HTMLElement).getByRole('button', { name: 'Check in now' }));
    await waitFor(() => expect(screen.queryByText(/expires in/)).not.toBeInTheDocument());
  });

});

describe('Settings → Licence', () => {
  it('shows the details, checks in, edits registration and opens the documents', async () => {
    const ok = registered({ status: 'granted', lastCheckinAt: new Date().toISOString(), graceUntil: new Date(Date.now() + GRACE_MS).toISOString() });
    await boot({ state: ok, path: '/settings' });
    expect(await screen.findByTestId('licence-status')).toHaveTextContent('Licensed. Check-in valid for 30 more days.');
    expect(screen.getByText('abcdef12')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Version ${EULA_VERSION}, accepted`))).toBeInTheDocument();

    replies.push(async () => new Response('', { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Check in now' }));
    expect(await screen.findByText('licence server replied 503')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change details' }));
    const d = await screen.findByRole('dialog', { name: 'Registration details' });
    expect(field('Your name').value).toBe('Op');
    expect(field('Computer name')).toBeDisabled();
    type(field('Email'), 'bad');
    fireEvent.click(within(d).getByRole('button', { name: 'Save and check in' }));
    expect(await within(d).findByText('Enter a valid email address')).toBeInTheDocument();
    type(field('Email'), 'new@example.com');
    fireEvent.click(within(d).getByRole('button', { name: 'Save and check in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('new@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Privacy notice' }));
    const doc = await screen.findByRole('dialog', { name: 'Privacy notice' });
    expect(within(doc).getByText(/does not use a microphone/)).toBeInTheDocument();
    fireEvent.click(within(doc).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Licence agreement' }));
    expect(within(await screen.findByRole('dialog', { name: 'Licence agreement' })).getByText('3. Registration and check-in')).toBeInTheDocument();
  });
});

describe('window start-up', () => {
  it("a window's first status replies don't overwrite a newer licence event", async () => {
    const { setBridge } = await import('@renderer/api/bridge');
    const { startSync } = await import('@renderer/services/sync');
    const { createDefaultMixerState } = await import('@shared/domain/defaults');
    const { initialRackStatus } = await import('@renderer/state/appStore');
    const listeners = new Map<string, (p: unknown) => void>();
    let releaseSnapshot!: () => void;
    const view = (allowed: boolean, checking: boolean) => ({ ...useAppStore.getState().licence, launch: { allowed, reason: 'granted', showMode: false }, checking }) as never;
    const answers: Record<string, unknown> = {
      'rack:status': initialRackStatus, 'settings:get': null,
      'legal:status': { eulaVersion: 'x', accepted: true, acceptedAt: null }, 'licence:status': view(false, true), 'update:status': null,
    };
    setBridge({
      invoke: async (ch: string) => {
        if (ch === 'mixer:snapshot') { await new Promise<void>((r) => (releaseSnapshot = r)); return { seq: 1, state: createDefaultMixerState() }; }
        return answers[ch] as never;
      },
      on: (ch: string, cb: (p: unknown) => void) => { listeners.set(ch, cb); return () => listeners.delete(ch); },
      platform: 'darwin',
    } as never);
    const started = startSync();
    await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf('function'));
    listeners.get('licence:changed')!(view(true, false)); // the boot check-in succeeded while the replies were in flight
    releaseSnapshot();
    const unsync = await started;
    expect(useAppStore.getState().licence).toMatchObject({ launch: { allowed: true }, checking: false });
    unsync();
  });
});

it('without licence services (tests, dev hosts) nothing is gated', async () => {
  const app = await bootApp('/settings');
  stop = app.stop;
  expect(await screen.findByTestId('licence-status')).toHaveTextContent('Licensed');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

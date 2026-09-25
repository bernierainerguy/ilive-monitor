import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { monitorBuses } from '@shared/monitorPolicy';
import type { RackTarget } from '@shared/settings';
import { bootApp, settle } from '../helpers/renderApp';
import type { Backend } from '../helpers/backend';

vi.mock('electron', () => import('../helpers/electronMock'));

const SIM: RackTarget = { id: 'sim', name: 'Sim', host: '', port: 0, protocol: 'simulator', midiChannel: 0, autoConnect: true };
let stop: ((keepDir?: boolean) => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function boot(path = '/mix', opts: Parameters<typeof bootApp>[2] = {}) {
  const app = await bootApp(path, {}, opts);
  stop = app.stop;
  return app;
}

/** Connect the backend to its simulated rack, as the Rack settings would. */
async function connect(be: Backend) {
  await act(async () => {
    be.settings.upsertRack(SIM);
    await be.bridge.invoke('rack:connect', { targetId: SIM.id });
  });
  await waitFor(() => expect(be.session.current.phase).toBe('online'));
}

const aux = (be: Backend, n: number) => monitorBuses(be.cache.state)[n - 1]!.ref.index;
const sendLevel = (be: Backend, input: number, bus: number) => be.rack.state.inputs[input]!.sends[bus]?.levelDb ?? -Infinity;

describe('first launch', () => {
  it('asks for a mix and a rack, and the faders stay away until both are set', async () => {
    await boot();
    expect(await screen.findByRole('heading', { name: 'Choose your mix' })).toBeInTheDocument();
    expect(screen.getByText(/Not connected to a rack/)).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(await screen.findByRole('radiogroup', { name: 'Mix bus' })).toBeInTheDocument();
  });

  it('a rack added in Settings connects, and choosing a mix opens its sends on the faders', async () => {
    const { be } = await boot('/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Add rack' }));
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Simulator' }));
    fireEvent.click(screen.getByRole('button', { name: /^Connect to/ }));
    await waitFor(() => expect(be.session.current.phase).toBe('online'));
    expect(be.settings.current.racks).toHaveLength(2); // the built-in simulator and the new one

    const picker = screen.getByRole('radiogroup', { name: 'Mix bus' });
    const radios = within(picker).getAllByRole('radio');
    expect(radios).toHaveLength(monitorBuses(be.cache.state).length); // auxes only: no groups, matrices or mains
    fireEvent.click(radios[2]!);
    await waitFor(() => expect(be.settings.current.bus).toBe(aux(be, 3)));
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Mix' }));
    expect(await screen.findByLabelText(/^Mix: Aux 3/)).toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(8); // one bank that fits the (test) window
  });
});

describe('the mix screen', () => {
  it('only has input send faders: no mutes, pan, PAFL, FX returns, channel faders or other buses', async () => {
    const { be } = await boot();
    await connect(be);
    await act(async () => void be.settings.update({ bus: aux(be, 1) }));
    const bank = await screen.findByTestId('send-bank');
    expect(within(bank).getAllByRole('slider').every((s) => /send$/.test(s.getAttribute('aria-label') ?? ''))).toBe(true);
    expect(screen.queryByRole('button', { name: /mute|pafl|pan|solo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aux 2|Sends on/i })).not.toBeInTheDocument(); // the bus can't be changed here
    expect(screen.queryByTestId(/^send-fxReturn/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /FX/ })).not.toBeInTheDocument();
  });

  it('shows one bank that fits the window, chosen with the bank keys; nothing scrolls', async () => {
    const { be } = await boot();
    await act(async () => void be.settings.update({ bus: aux(be, 1) }));
    const bank = await screen.findByTestId('send-bank');
    expect(bank).toHaveStyle({ overflow: 'hidden' });
    const keys = within(screen.getByRole('group', { name: 'Banks' })).getAllByRole('button');
    expect(keys.map((k) => k.textContent)).toEqual(['Ch 1–8', 'Ch 9–16', 'Ch 17–24', 'Ch 25–32', 'Ch 33–40', 'Ch 41–48', 'Ch 49–56', 'Ch 57–64']);
    expect(keys[0]).toHaveAttribute('aria-pressed', 'true');
    expect(within(bank).getAllByRole('slider')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Ch 57–64' }));
    expect(screen.getByTestId('send-input:63')).toBeInTheDocument();
    expect(screen.queryByTestId('send-input:0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ch 57–64' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a fader or a typed level sets the send on the rack, and nothing else moves', async () => {
    const { be } = await boot();
    await connect(be);
    const bus = aux(be, 2);
    await act(async () => void be.settings.update({ bus }));
    const before = structuredClone(be.rack.state);

    fireEvent.click(within(await screen.findByTestId('send-input:0')).getByRole('button', { name: /^Edit .* send level$/ }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '-6' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await settle();
    expect(sendLevel(be, 0, bus)).toBe(-6);

    const fader = within(screen.getByTestId('send-input:1')).getByRole('slider');
    fireEvent.keyDown(fader, { key: 'ArrowUp' });
    await settle();
    expect(sendLevel(be, 1, bus)).toBeGreaterThan(-Infinity);

    // Everything except those two sends is exactly as it was.
    const after = structuredClone(be.rack.state);
    after.inputs[0]!.sends[bus] = before.inputs[0]!.sends[bus]!;
    after.inputs[1]!.sends[bus] = before.inputs[1]!.sends[bus]!;
    expect(after).toEqual(before);
  });

  it('follows the rack: a send moved on the console moves the fader here', async () => {
    const { be } = await boot();
    await connect(be);
    const bus = aux(be, 1);
    await act(async () => void be.settings.update({ bus }));
    await screen.findByTestId('send-bank');
    act(() => be.rack.apply({ t: 'send', strip: { kind: 'input', index: 4 }, target: { kind: 'mix', index: bus }, patch: { levelDb: -12 } }));
    await waitFor(() => expect(within(screen.getByTestId('send-input:4')).getByRole('slider')).toHaveAttribute('aria-valuenow', '-12'));
  });

  it('locks the faders while offline', async () => {
    const { be } = await boot();
    await act(async () => void be.settings.update({ bus: aux(be, 1) }));
    await screen.findByTestId('send-bank');
    expect(screen.getAllByRole('slider').every((s) => s.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(screen.getByText(/faders are locked until you connect/)).toBeInTheDocument();
  });

  it('ghosts sends the rack has not reported (MIDI) until they move, and counts them', async () => {
    const { be } = await boot('/mix', { midiLike: true });
    await connect(be);
    const bus = aux(be, 1);
    await act(async () => void be.settings.update({ bus }));
    expect(await screen.findByText(/64 send levels not known yet/)).toBeInTheDocument();
    expect(within(screen.getByTestId('send-input:0')).getByRole('button', { name: /level$/ })).toHaveTextContent('?');
    act(() => be.rack.apply({ t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: bus }, patch: { levelDb: -3 } }));
    expect(await screen.findByText(/63 send levels not known yet/)).toBeInTheDocument();
    expect(within(screen.getByTestId('send-input:0')).getByRole('button', { name: /level$/ })).toHaveTextContent('-3');
  });

  it('when the chosen bus is not an aux on this rack, asks for it again', async () => {
    const { be } = await boot();
    const group = be.cache.state.mixes.find((m) => m.role === 'group')!.ref.index;
    await act(async () => void be.settings.update({ bus: group }));
    expect(await screen.findByRole('heading', { name: /isn.t an aux on this rack/ })).toBeInTheDocument();
  });
});

describe('the bus is kept between launches', () => {
  it('a relaunch opens straight on the same mix', async () => {
    const first = await boot();
    await act(async () => void first.be.settings.update({ bus: aux(first.be, 4) }));
    const dir = first.be.dir;
    await first.stop(true);
    stop = null;
    await boot('/mix', { dir });
    expect(await screen.findByLabelText(/^Mix: Aux 4/)).toBeInTheDocument();
  });
});

describe('bypassing the UI changes nothing', () => {
  it('main refuses anything but a send level to the chosen bus, even straight over IPC', async () => {
    const { be } = await boot();
    await connect(be);
    const bus = aux(be, 1);
    await act(async () => void be.settings.update({ bus }));
    const before = structuredClone(be.rack.state);
    const r = await be.bridge.invoke('mixer:dispatch', [
      { t: 'fader', strip: { kind: 'input', index: 0 }, db: 0 },
      { t: 'mute', strip: { kind: 'mix', index: bus }, on: true },
      { t: 'eq', strip: { kind: 'input', index: 0 }, patch: { enabled: false } },
      { t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: aux(be, 2) }, patch: { levelDb: 0 } },
      { t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: bus }, patch: { muted: true } },
    ]);
    expect(r).toMatchObject({ accepted: 0 });
    expect(r.rejected).toHaveLength(5);
    await settle();
    expect(be.rack.state).toEqual(before);
    await expect(be.bridge.invoke('settings:update', { bus: 'x' as never })).resolves.toMatchObject({ bus: null });
  });

  it('there is no channel for shows, scenes, processing, routing or profiles', async () => {
    const { be } = await boot();
    for (const ch of ['show:save', 'scene:recall', 'library:recall', 'profile:update', 'rack:sync', 'window:open']) {
      await expect(be.bridge.invoke(ch as never, undefined as never)).rejects.toThrow(/no handler/);
    }
  });
});

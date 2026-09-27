import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RackTarget } from '@shared/settings';
import { bootApp } from '../helpers/renderApp';

vi.mock('electron', () => import('../helpers/electronMock'));

// What the studio iDR48 answered (CH 60..7F), and its FX sends.
const STUDIO = {
  mixes: ['ComOut', 'LOOP', 'Talk', 'Proprese', 'Gtr', 'Gtr', 'Keys', 'Keys', 'Bass', 'Bass', 'Drums', 'Drums', 'V1', 'V1', 'V2', 'V2', 'V3', 'V3', 'V', 'V', '9', '9', '10', '10', 'Main', 'FOH R', null, null, null, null, null, null],
  fx: ['RVB R', 'RVB H', 'RVB P', 'DLY', '5', '6', '7', '8'],
};
const IDR48: RackTarget = { id: 'idr', name: 'iDR48', host: '10.0.0.10', port: 51325, protocol: 'ilive-midi-tcp', midiChannel: 0, autoConnect: true };

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function bootConnected() {
  const app = await bootApp('/settings');
  stop = app.stop;
  const { be } = app;
  await act(async () => {
    be.settings.upsertRack(IDR48);
    await be.bridge.invoke('rack:connect', { targetId: IDR48.id });
  });
  await waitFor(() => expect(be.session.current.phase).toBe('online'));
  vi.spyOn(be.session, 'readRackNames').mockResolvedValue(structuredClone(STUDIO) as never);
  fireEvent.click(await screen.findByRole('tab', { name: 'Rack' }));
  fireEvent.click(screen.getByText('10.0.0.10:51325 · MIDI ch 1'));
  return be;
}

describe('Read from rack', () => {
  it('fills in the layout from the rack’s names, and won’t save until groups and FX sends are checked', async () => {
    const be = await bootConnected();
    fireEvent.click(screen.getByRole('button', { name: 'Read from rack' }));
    await waitFor(() => expect(screen.getByLabelText('Mono auxes')).toHaveValue(4));
    expect(screen.getByLabelText('Stereo auxes')).toHaveValue(10);
    expect(screen.getByLabelText('Mono groups')).toHaveValue(0);

    const channels = within(screen.getByLabelText('Mix channels'));
    expect(channels.getByText('Aux 5 L').parentElement).toHaveTextContent('Gtr');
    expect(channels.getByText('Main R').parentElement).toHaveTextContent('FOH R');
    expect(screen.getByText(/FX sends on the rack: RVB R, RVB H/)).toBeInTheDocument();

    const saves = () => screen.getAllByRole('button', { name: 'Save' });
    expect(saves().length).toBe(2); // the rack card's, and one beside the tick
    expect(saves().every((b) => (b as HTMLButtonElement).disabled)).toBe(true); // groups and FX sends not yet checked
    expect(screen.getByText('Tick the box to save.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Mono fx sends'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText(/I’ve checked the groups and FX sends/));
    expect(saves().every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Rack layout' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(be.settings.current.racks.find((r) => r.id === IDR48.id)?.mixConfig).toMatchObject({ monoAuxes: 4, stereoAuxes: 10, main: 'lr', monoFx: 4 }));
  });

  it('marks the channels that don’t match when a number is wrong', async () => {
    await bootConnected();
    fireEvent.click(screen.getByRole('button', { name: 'Read from rack' }));
    await waitFor(() => expect(screen.getByLabelText('Mono auxes')).toHaveValue(4));
    fireEvent.change(screen.getByLabelText('Mono auxes'), { target: { value: '3' } });
    expect(await screen.findByText(/channels below don’t match the rack/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-mismatch]').length).toBeGreaterThan(10);
  });

  it('says when edits aren\'t saved yet', async () => {
    await bootConnected();
    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: '10.0.0.11' } });
    expect(await screen.findByText(/Not saved yet/)).toBeInTheDocument();
  });

  it('needs the rack connected, and Settings unlocked', async () => {
    const app = await bootApp('/settings');
    stop = app.stop;
    await act(async () => void app.be.settings.upsertRack(IDR48));
    await expect(app.be.bridge.invoke('rack:readNames', { targetId: IDR48.id })).rejects.toThrow(/Connect to this rack first/);
    fireEvent.click(await screen.findByRole('tab', { name: 'Rack' }));
    fireEvent.click(screen.getByText('10.0.0.10:51325 · MIDI ch 1'));
    expect(screen.getByRole('button', { name: 'Read from rack' })).toBeDisabled();
  });
});

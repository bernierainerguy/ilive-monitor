import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Logger } from '@main/logging/Logger';
import { TEAM_ID, UpdateService, type UpdateDeps } from '@main/services/UpdateService';
import { useAppStore } from '@renderer/state/appStore';
import { bootApp } from '../helpers/renderApp';

vi.mock('electron', () => import('../helpers/electronMock'));

const DMG = 'https://whiteleyevents.co.uk/wp-content/uploads/whe-software/Whiteley-Events-AH-iLive-Monitor/MAC/WEIM-0.6.0-arm64.dmg';
const feed = (version = '0.6.0', platforms: Record<string, unknown> = { 'macos-arm': { url: DMG, filename: `WEIM-${version}-arm64.dmg` } }) =>
  new Response(JSON.stringify({ success: true, data: { version, page: 'https://whiteleyevents.co.uk/software/', platforms } }));

let dir: string;
let stop: (() => Promise<void>) | null = null;
let site: (url: string) => Promise<Response>;
let deps: Pick<UpdateDeps, 'openPath' | 'showItemInFolder' | 'openExternal'>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ilive-ui-upd-'));
  site = async (u) => (u.includes('welm-api') ? feed() : new Response('DMGDATA', { headers: { 'content-length': '7' } }));
  deps = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) };
});
afterEach(async () => {
  await stop?.();
  stop = null;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(path = '/mix') {
  const updates = new UpdateService({
    currentVersion: '0.5.1', log: new Logger('error'), downloadsDir: dir,
    fetch: ((u: string) => site(u)) as typeof fetch, signingTeam: async () => TEAM_ID, showMode: () => false, ...deps,
  });
  const app = await bootApp(path, { updates });
  stop = app.stop;
  return { ...app, updates };
}
const dialog = (name: string | RegExp) => screen.findByRole('dialog', { name });

describe('updates', () => {
  it('launch prompt → Download → Open installer / Show in Finder, with the pill tracking progress', async () => {
    const { updates } = await boot();
    await screen.findByRole('heading', { name: 'Choose your mix' });
    await act(async () => void (await (updates as unknown as { automatic(k: string): Promise<void> }).automatic('launch')));
    const d = await dialog('iLive Monitor 0.6.0 is available');
    expect(within(d).getByText(/You have 0.5.1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update: ↑ v0.6.0 available', hidden: true })).toBeInTheDocument(); // behind the dialog
    fireEvent.click(within(d).getByRole('button', { name: 'Download' }));

    const ready = await dialog('iLive Monitor 0.6.0 is ready');
    expect(screen.getByRole('button', { name: 'Update: v0.6.0 downloaded', hidden: true })).toBeInTheDocument();
    expect(deps.openPath).not.toHaveBeenCalled(); // nothing opens by itself
    fireEvent.click(within(ready).getByRole('button', { name: 'Show in Finder' }));
    await waitFor(() => expect(deps.showItemInFolder).toHaveBeenCalledWith(join(dir, 'WEIM-0.6.0-arm64.dmg')));
    fireEvent.click(within(ready).getByRole('button', { name: 'Open installer' }));
    await waitFor(() => expect(deps.openPath).toHaveBeenCalledWith(join(dir, 'WEIM-0.6.0-arm64.dmg')));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // the pill reopens it
    fireEvent.click(screen.getByRole('button', { name: 'Update: v0.6.0 downloaded' }));
    fireEvent.click(within(await dialog('iLive Monitor 0.6.0 is ready')).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Later on the launch prompt leaves just the pill', async () => {
    const { updates } = await boot();
    await act(async () => void (await (updates as unknown as { automatic(k: string): Promise<void> }).automatic('launch')));
    fireEvent.click(within(await dialog(/is available/)).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useAppStore.getState().update?.dialog).toBeNull();
    expect(screen.getByRole('button', { name: 'Update: ↑ v0.6.0 available' })).toBeInTheDocument();
  });

  it('Settings → About: Check for updates answers every time — up to date, failure, available', async () => {
    await boot('/settings');
    await screen.findByRole('button', { name: 'Check for updates' });
    site = async () => feed('0.5.1');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(within(await dialog('You’re up to date')).getByRole('button', { name: 'OK' }));
    expect(await screen.findByText(/^Up to date \(checked/)).toBeInTheDocument();

    site = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    const failed = await dialog('Couldn’t check for updates');
    expect(within(failed).getByText('fetch failed (ENOTFOUND)')).toBeInTheDocument();
    fireEvent.click(within(failed).getByRole('button', { name: 'OK' }));
    expect(await screen.findByText("Couldn't check: fetch failed (ENOTFOUND)")).toBeInTheDocument();

    site = async (u) => (u.includes('welm-api') ? feed() : new Response(null, { status: 404 }));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(within(await dialog('iLive Monitor 0.6.0 is available')).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // a failed re-check keeps the known update on offer
    const working = site;
    site = async () => new Response('{}', { status: 502 });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    const still = await dialog('Couldn’t check for updates');
    expect(within(still).getByText(/0.6.0 was found earlier and is still available/)).toBeInTheDocument();
    site = working;
    fireEvent.click(within(still).getByRole('button', { name: 'Show 0.6.0' }));
    fireEvent.click(within(await dialog('iLive Monitor 0.6.0 is available')).getByRole('button', { name: 'Download' }));

    const bad = await dialog('Download failed');
    expect(within(bad).getByText(/download failed \(404\)/)).toBeInTheDocument();
    fireEvent.click(within(bad).getByRole('button', { name: 'Open download page' }));
    await waitFor(() => expect(deps.openExternal).toHaveBeenCalledWith('https://whiteleyevents.co.uk/software/'));
    expect(await screen.findByText('Download of 0.6.0 failed: download failed (404)')).toBeInTheDocument();
  });

  it('a feed with no installer for this Mac offers the download page', async () => {
    site = async () => feed('0.6.0', { windows: { url: 'https://whiteleyevents.co.uk/x.exe' } });
    await boot('/settings');
    await screen.findByRole('button', { name: 'Check for updates' });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    const d = await dialog('iLive Monitor 0.6.0 is available');
    expect(within(d).getByText(/Get it from the Whiteley Events website/)).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: 'Open download page' }));
    await waitFor(() => expect(deps.openExternal).toHaveBeenCalledWith('https://whiteleyevents.co.uk/software/'));
  });

});

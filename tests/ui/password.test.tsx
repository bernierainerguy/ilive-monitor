import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Logger } from '@main/logging/Logger';
import { LockService } from '@main/services/LockService';
import { bootApp } from '../helpers/renderApp';

vi.mock('electron', () => import('../helpers/electronMock'));

let dir: string;
let stop: (() => Promise<void>) | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ilm-ui-lock-'));
});
afterEach(async () => {
  await stop?.();
  stop = null;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(password: string | null, path = '/settings') {
  const lock = new LockService(join(dir, 'settings-lock.json'), new Logger('error'));
  await lock.init();
  if (password) {
    await lock.setPassword(password);
    lock.lock();
  }
  const app = await bootApp(path, { lock });
  stop = app.stop;
  return { ...app, lock };
}

const typePassword = (value: string) => fireEvent.change(screen.getByLabelText('Password'), { target: { value } });

describe('Settings password', () => {
  it('locked Settings shows only the unlock prompt; a wrong password is refused, the right one opens it', async () => {
    await boot('front-of-house');
    expect(await screen.findByRole('heading', { name: 'Settings are locked' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Mix bus' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rack' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toContainElement(screen.getByLabelText('locked'));

    typePassword('guess');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
    typePassword('front-of-house');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('radiogroup', { name: 'Mix bus' })).toBeInTheDocument();
  });

  it('leaving Settings locks it again', async () => {
    const { lock } = await boot('front-of-house');
    typePassword('front-of-house');
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    await screen.findByRole('radiogroup', { name: 'Mix bus' });
    expect(lock.unlocked).toBe(true);
    const views = within(screen.getByRole('navigation', { name: 'Views' }));
    fireEvent.click(views.getByRole('button', { name: 'Mix' }));
    await waitFor(() => expect(lock.unlocked).toBe(false));
    fireEvent.click(views.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings are locked' })).toBeInTheDocument();
  });

  it('while locked, main refuses every Settings change, even straight over IPC', async () => {
    const { be } = await boot('front-of-house', '/mix');
    await screen.findByRole('heading', { name: 'Choose your mix' });
    const refused = [
      be.bridge.invoke('settings:update', { aux: 2 }),
      be.bridge.invoke('settings:update', { themeId: 'light' }),
      be.bridge.invoke('rack:connect', { targetId: 'simulator' }),
      be.bridge.invoke('rack:disconnect', undefined),
      be.bridge.invoke('rack:saveTarget', { id: 'x', name: 'X', host: 'h', port: 51325, protocol: 'ilive-midi-tcp', midiChannel: 0, autoConnect: true }),
      be.bridge.invoke('rack:deleteTarget', { id: 'simulator' }),
      be.bridge.invoke('lock:setPassword', { password: null }),
    ];
    for (const r of refused) await expect(r).rejects.toThrow(/Settings are locked/);
    expect(be.settings.current).toMatchObject({ aux: null, themeId: 'dark' });
    expect(be.settings.current.racks.map((r) => r.id)).toEqual(['simulator']);
    expect(be.session.current.phase).toBe('offline');
  });

  it('the mix keeps working while Settings is locked', async () => {
    const { be, lock } = await boot(null, '/mix');
    await act(async () => void be.settings.update({ aux: 1 }));
    await act(async () => {
      await be.bridge.invoke('rack:connect', { targetId: 'simulator' });
      await lock.setPassword('abcd');
      lock.lock();
    });
    await waitFor(() => expect(be.session.current.phase).toBe('online'));
    const r = await be.bridge.invoke('mixer:dispatch', [{ t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: 0 }, patch: { levelDb: -5 } }]);
    expect(r.accepted).toBe(1);
  });

  it('sets, changes and removes the password from Settings', async () => {
    const { lock } = await boot(null);
    const section = within(await screen.findByRole('region', { name: 'Password' }));
    expect(section.getByText(/Anyone can open Settings/)).toBeInTheDocument();
    fireEvent.change(section.getByLabelText('Password'), { target: { value: 'ab' } });
    fireEvent.click(section.getByRole('button', { name: 'Set password' }));
    expect(await section.findByText('At least 4 characters')).toBeInTheDocument();
    fireEvent.change(section.getByLabelText('Password'), { target: { value: 'abcd' } });
    fireEvent.change(section.getByLabelText('Password again'), { target: { value: 'abce' } });
    fireEvent.click(section.getByRole('button', { name: 'Set password' }));
    expect(await section.findByText('Doesn’t match')).toBeInTheDocument();
    fireEvent.change(section.getByLabelText('Password again'), { target: { value: 'abcd' } });
    fireEvent.click(section.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(lock.status).toMatchObject({ hasPassword: true, unlocked: true }));
    expect(await section.findByText(/Settings are password protected/)).toBeInTheDocument();

    fireEvent.change(section.getByLabelText('New password'), { target: { value: 'wxyz' } });
    fireEvent.change(section.getByLabelText('Password again'), { target: { value: 'wxyz' } });
    fireEvent.click(section.getByRole('button', { name: 'Change' }));
    await screen.findByText('Password changed');
    lock.lock();
    expect(() => lock.unlock('abcd')).toThrow();
    lock.unlock('wxyz');

    fireEvent.click(section.getByRole('button', { name: 'Remove password' }));
    await waitFor(() => expect(lock.status.hasPassword).toBe(false));
  });

  it('Lock now locks straight away', async () => {
    const { lock } = await boot(null);
    await act(async () => void (await lock.setPassword('abcd')));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock now' }));
    expect(await screen.findByRole('heading', { name: 'Settings are locked' })).toBeInTheDocument();
  });
});

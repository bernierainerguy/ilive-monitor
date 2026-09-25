import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let dataDir: string;

/** A registered, licensed install with the EULA accepted, so the app starts straight on its screen. */
function seedLicence(dir: string) {
  const eula = /EULA_VERSION = '([\d-]+)'/.exec(readFileSync(join(__dirname, '../../src/main/services/LegalService.ts'), 'utf8'))![1];
  writeFileSync(join(dir, 'eula-acceptance.json'), JSON.stringify({ version: eula, acceptedAt: new Date().toISOString() }));
  writeFileSync(join(dir, 'licence-checkin.json'), JSON.stringify({
    uuid: '00000000-0000-4000-8000-00000000e2e0', name: 'E2E', email: 'e2e@example.com', machineName: 'e2e', status: 'granted',
    deniedReason: null, lastCheckinAt: new Date().toISOString(), graceUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(), lastError: null,
  }));
}

// Check-ins go to a closed local port: never the live server, and they fail fast (the cached grant stands).
const launch = () =>
  electron.launch({ args: [join(__dirname, '../../out/main/index.js')], env: { ...process.env, ILIVE_MONITOR_USER_DATA: dataDir, ILIVE_LICENCE_SERVER: 'http://127.0.0.1:9' } });

test.beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ilive-monitor-e2e-'));
  seedLicence(dataDir);
});
test.afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test('first launch → simulator → choose a mix → move a send; the mix is kept on relaunch', async () => {
  let app: ElectronApplication = await launch();
  let page: Page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Choose your mix' })).toBeVisible({ timeout: 3000 });

  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByRole('tab', { name: 'Rack' }).click();
  await page.getByRole('button', { name: 'Connect to iDR48 Simulator' }).click(); // pre-selected
  await expect(page.getByRole('button', { name: /^Rack: iDR48 Simulator, online/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Mix bus' }).click();
  await page.getByRole('radiogroup', { name: 'Mix bus' }).getByRole('radio').nth(1).click();
  await page.getByRole('button', { name: 'Mix', exact: true }).click();
  await expect(page.getByLabel(/^Mix: Aux 2/)).toBeVisible();
  await expect(page.getByRole('slider')).toHaveCount(16); // a 1440 px window fits a bank of 16
  const noScroll = await page.getByTestId('send-bank').evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(noScroll).toBe(true);
  await page.getByRole('button', { name: 'Ch 49–64' }).click();
  await expect(page.getByTestId('send-input:63')).toBeVisible();
  await page.getByRole('button', { name: 'Ch 1–16' }).click();
  await expect(page.getByRole('button', { name: /mute|pafl/i })).toHaveCount(0);

  const fader = page.getByTestId('send-input:0').getByRole('slider');
  await fader.focus();
  await page.keyboard.press('ArrowUp');
  await expect(fader).not.toHaveAttribute('aria-valuenow', '-90');
  await page.screenshot({ path: join(__dirname, '../../test-results/mix.png') });
  await app.close();

  app = await launch();
  page = await app.firstWindow();
  await expect(page.getByLabel(/^Mix: Aux 2/)).toBeVisible();
  await app.close();
});

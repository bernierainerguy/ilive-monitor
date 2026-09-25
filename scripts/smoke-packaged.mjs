/**
 * Launch the *packaged* app (not the source build) and prove it works before
 * anything is published: it starts, shows the mixer, and reports the version
 * being released. Lesson from WESC: test the artefact itself.
 *
 *   node scripts/smoke-packaged.mjs "release/0.5.0/mac-arm64/iLive Monitor.app" 0.5.0
 */
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [appPath, version] = process.argv.slice(2);
if (!appPath || !version) {
  console.error('usage: smoke-packaged.mjs <path/to/iLive Monitor.app> <version>');
  process.exit(2);
}
const data = mkdtempSync(join(tmpdir(), 'ilive-monitor-smoke-'));
// Start as a registered, licensed install with the EULA accepted (the gate itself is covered by the test suite),
// and send check-ins to a closed local port so a release never registers a fake install on the live site.
const eula = /EULA_VERSION = '([\d-]+)'/.exec(readFileSync(new URL('../src/main/services/LegalService.ts', import.meta.url), 'utf8'))[1];
writeFileSync(join(data, 'eula-acceptance.json'), JSON.stringify({ version: eula, acceptedAt: new Date().toISOString() }));
writeFileSync(join(data, 'licence-checkin.json'), JSON.stringify({
  uuid: '00000000-0000-4000-8000-0000000005e0', name: 'Release smoke test', email: 'smoke@example.com', machineName: 'smoke', status: 'granted',
  deniedReason: null, lastCheckinAt: new Date().toISOString(), graceUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(), lastError: null,
}));
const started = Date.now();
let app;
try {
  app = await electron.launch({
    executablePath: join(appPath, 'Contents', 'MacOS', 'iLive Monitor'),
    env: { ...process.env, ILIVE_MONITOR_USER_DATA: data, ILIVE_LICENCE_SERVER: 'http://127.0.0.1:9' },
    timeout: 60_000,
  });
  const reported = await app.evaluate(({ app: a }) => a.getVersion());
  if (reported !== version) throw new Error(`packaged app reports ${reported}, expected ${version}`);
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Choose your mix' }).waitFor({ timeout: 30_000 });
  const ms = Date.now() - started;
  console.log(`✓ packaged app ${reported} launched and showed the mix screen in ${ms} ms`);
} catch (err) {
  console.error(`✗ packaged app smoke test failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  rmSync(data, { recursive: true, force: true });
}

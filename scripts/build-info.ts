/** Version, commit and build time baked into the app at build time (shown in Settings → About). */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function buildInfo() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const sha = git('rev-parse --short HEAD') || 'unknown';
  const dirty = git('status --porcelain') !== '';
  return { version, commit: dirty ? `${sha}-dirty` : sha, builtAt: new Date().toISOString() };
}

/** Vite `define` map for the renderer. */
export function buildDefines(): Record<string, string> {
  const b = buildInfo();
  return {
    __APP_VERSION__: JSON.stringify(b.version),
    __GIT_COMMIT__: JSON.stringify(b.commit),
    __BUILD_DATE__: JSON.stringify(b.builtAt),
  };
}

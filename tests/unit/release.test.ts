import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildInfo } from '../../scripts/build-info';

const require = createRequire(import.meta.url);
const { releaseChangelog } = require('../../scripts/changelog.cjs') as { releaseChangelog(t: string, v: string, d: string): string };


const LOG = `# Changelog

## [Unreleased]

### Added
- Thing one.

### Fixed
- Bug two.

## [0.1.0] - 2026-09-24

### Added
- First.

[Unreleased]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bernierainerguy/ilive-monitor/releases/tag/v0.1.0
`;

describe('releaseChangelog', () => {
  it('moves Unreleased notes into a dated version and leaves Unreleased empty', () => {
    const out = releaseChangelog(LOG, '0.2.0', '2026-10-01');
    expect(out).toMatch(/## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-01\n\n### Added\n- Thing one\.\n\n### Fixed\n- Bug two\.\n\n## \[0\.1\.0\]/);
    expect(out).toContain('[Unreleased]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.2.0...HEAD');
    expect(out).toContain('[0.2.0]: https://github.com/bernierainerguy/ilive-monitor/compare/v0.1.0...v0.2.0');
    expect(out).toContain('[0.1.0]: https://github.com/bernierainerguy/ilive-monitor/releases/tag/v0.1.0');
  });

  it('refuses to release with no notes, twice, or without an Unreleased section', () => {
    const released = releaseChangelog(LOG, '0.2.0', '2026-10-01');
    expect(() => releaseChangelog(released, '0.2.1', '2026-10-02')).toThrow(/Nothing under "Unreleased"/);
    expect(() => releaseChangelog(LOG.replace('## [0.1.0]', '## [0.2.0]'), '0.2.0', 'x')).toThrow(/already has a 0.2.0/);
    expect(() => releaseChangelog('# Changelog\n', '1.0.0', 'x')).toThrow(/no "## \[Unreleased\]"/);
  });

  it('first ever release links to its tag', () => {
    const out = releaseChangelog('# C\n\n## [Unreleased]\n\n- a\n\n[Unreleased]: x\n', '0.1.0', '2026-01-01');
    expect(out).toContain('[0.1.0]: https://github.com/bernierainerguy/ilive-monitor/releases/tag/v0.1.0');
  });

  it('the real CHANGELOG.md has an Unreleased section with notes and the current version', () => {
    const real = readFileSync(join(__dirname, '../../CHANGELOG.md'), 'utf8');
    const { version } = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    expect(real).toContain('## [Unreleased]');
    expect(real).toContain(`## [${version}]`);
  });
});

describe('build info', () => {
  it('reports the package version, a commit and a timestamp', () => {
    const b = buildInfo();
    const { version } = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    expect(b.version).toBe(version);
    expect(b.commit).toMatch(/^[0-9a-f]{7,}(-dirty)?$|^unknown$/);
    expect(Number.isNaN(Date.parse(b.builtAt))).toBe(false);
  });
});

describe('site release', () => {
  const root = join(__dirname, '../..');
  const sh = readFileSync(join(root, 'scripts/release-site.sh'), 'utf8');

  it('builds, uploads and keeps the legal PDFs alongside the DMG', () => {
    expect(sh).toContain('python3 scripts/build-legal-pdfs.py');
    expect(sh).toMatch(/LEGAL_PDFS=\(legal\/WEIM-EULA\.pdf legal\/WEIM-Privacy-Notice\.pdf legal\/WEIM-Third-Party-Licences\.pdf\)/);
    expect(sh).toContain('UPLOADS=("$DMG" "${LEGAL_PDFS[@]}")');
    // the keep-list comes from the upload list, so a new upload can never be pruned straight away
    expect(sh).toContain('for f in "${UPLOADS[@]}"; do KEEP+=(--keep "$f"); done');
    // PDFs are built before packaging, so they are inside the app too
    expect(sh.indexOf('build-legal-pdfs.py')).toBeLessThan(sh.indexOf('electron-builder --mac'));
    expect(readFileSync(join(root, 'electron-builder.yml'), 'utf8')).toMatch(/extraResources:\n\s+- from: legal\n\s+to: legal/);
  });

  it("never pipes into grep -q (under pipefail, grep quitting early can SIGPIPE the writer and fail a good release)", () => {
    expect(sh).toContain('set -euo pipefail');
    expect(sh).not.toMatch(/\|\s*grep -q/);
  });
});

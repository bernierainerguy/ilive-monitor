/**
 * Turns the "Unreleased" section of CHANGELOG.md into a dated release.
 * Runs from the npm `version` lifecycle (after package.json is bumped, before the
 * release commit), so every tagged version has its notes in the same commit.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const REPO = 'https://github.com/bernierainerguy/ilive-monitor';

function releaseChangelog(text, version, date) {
  const head = '## [Unreleased]';
  const start = text.indexOf(head);
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const bodyStart = start + head.length;
  const next = text.indexOf('\n## [', bodyStart);
  const body = text.slice(bodyStart, next < 0 ? undefined : next).trim();
  if (!body) throw new Error('Nothing under "Unreleased" in CHANGELOG.md: add release notes first');
  if (text.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has a ${version} section`);

  const prev = /\n## \[(\d+\.\d+\.\d+)\]/.exec(text.slice(bodyStart))?.[1];
  let out = `${text.slice(0, start)}${head}\n\n## [${version}] - ${date}\n\n${body}\n${next < 0 ? '' : text.slice(next)}`;

  out = out.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${REPO}/compare/v${version}...HEAD`);
  const link = prev ? `[${version}]: ${REPO}/compare/v${prev}...v${version}` : `[${version}]: ${REPO}/releases/tag/v${version}`;
  out = out.replace(/^(\[Unreleased\]: .*)$/m, `$1\n${link}`);
  return out;
}

module.exports = { releaseChangelog };

if (require.main === module) {
  const root = join(__dirname, '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const file = join(root, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(file, releaseChangelog(readFileSync(file, 'utf8'), version, date));
  console.log(`CHANGELOG.md: released ${version} (${date})`);
}

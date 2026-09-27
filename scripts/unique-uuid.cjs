/**
 * electron-builder afterPack hook: give this app's executables their own Mach-O UUIDs.
 *
 * Every Electron app built on the same Electron version ships the same prebuilt binary, so they all share one
 * LC_UUID (on this Mac: iLive Monitor, iLive Touch and the development Electron.app). macOS's Local Network
 * privacy keys its decision on that UUID, so iLive Monitor's connection to the rack was filed under another app:
 * macOS never asked, never listed iLive Monitor in Privacy & Security › Local Network, and refused it.
 *
 * Runs after packaging and before signing, so the signature covers the patched files. The UUIDs are derived from
 * the bundle id and the file's path inside the app, so they're the same on every build: a decision the operator
 * has made survives updates.
 */
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { join, relative } = require('node:path');

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_UUID = 0x1b;

/** A stable UUID (RFC 4122 version 5 layout) from a string. */
function uuidFor(seed) {
  const b = createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  return Buffer.from(b);
}

/** Replace the LC_UUID of one 64-bit little-endian Mach-O image starting at `base`. Returns true if found. */
function patchSlice(buf, base, uuid) {
  if (buf.readUInt32LE(base) !== MH_MAGIC_64) throw new Error('not a 64-bit Mach-O image');
  const ncmds = buf.readUInt32LE(base + 16);
  let off = base + 32; // mach_header_64
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_UUID) {
      uuid.copy(buf, off + 8);
      return true;
    }
    if (size < 8) throw new Error('malformed load command');
    off += size;
  }
  return false;
}

/** Patch every image in a thin or universal Mach-O buffer. Returns the number of images patched. */
function patchMachOUuid(buf, uuid) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    let patched = 0;
    for (let i = 0; i < n; i++) {
      const offset = buf.readUInt32BE(8 + i * 20 + 8); // fat_arch: cputype, cpusubtype, offset, size, align
      if (patchSlice(buf, offset, uuid)) patched++;
    }
    return patched;
  }
  return patchSlice(buf, 0, uuid) ? 1 : 0;
}

/** The app's own executables: the main one and each helper's. */
function executables(appPath) {
  const out = [];
  const macos = join(appPath, 'Contents', 'MacOS');
  for (const f of readdirSync(macos)) out.push(join(macos, f));
  const frameworks = join(appPath, 'Contents', 'Frameworks');
  if (existsSync(frameworks)) {
    for (const helper of readdirSync(frameworks).filter((f) => f.endsWith('.app'))) {
      const dir = join(frameworks, helper, 'Contents', 'MacOS');
      for (const f of readdirSync(dir)) out.push(join(dir, f));
    }
  }
  return out;
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const name = context.packager.appInfo.productFilename;
  const bundleId = context.packager.appInfo.id;
  const appPath = join(context.appOutDir, `${name}.app`);
  for (const file of executables(appPath)) {
    const buf = readFileSync(file);
    const uuid = uuidFor(`${bundleId}:${relative(appPath, file)}`);
    if (!patchMachOUuid(buf, uuid)) throw new Error(`no LC_UUID in ${file}`);
    writeFileSync(file, buf);
    console.log(`  • unique Mach-O UUID  file=${relative(appPath, file)}`);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.patchMachOUuid = patchMachOUuid;
module.exports.uuidFor = uuidFor;

/**
 * Hand-rolled `Arcelle.app.tar.gz` builder, per the research
 * doc's section 6 recommendation: build the updater payload with
 * `COPYFILE_DISABLE=1 tar -czf ... -C <dir> Arcelle.app` from the FINAL
 * signed app, exactly as `release.sh:169` already does, rather than adding
 * electron-builder's own `tar.gz` archive target.
 *
 * Why not the builder's `tar.gz` target (documented, not just asserted):
 *  - it names the artifact `${productName}-${version}-${arch}.${ext}` by
 *    default (`Arcelle-0.26.0-arm64-mac.tar.gz`), not the literal
 *    `Arcelle.app.tar.gz` every shipped Tauri client's `latest.json` URL and
 *    `tauriUpdater.ts`'s endpoint expect -- fixable with `mac.artifactName`,
 *    but then this hand-rolled path would be redundant with it, not simpler.
 *  - `ArchiveTarget` downloads a pinned 7zip toolset on first use
 *    (`toolsets/7zip.js`) to gzip the tar it builds with node-tar; `dmg` (the
 *    other target this candidate's config keeps) does not need that
 *    download, so keeping the updater payload off the 7zip path keeps a cold
 *    cache's critical path shorter.
 *  - this exact recipe (`/usr/bin/tar` + `COPYFILE_DISABLE=1`) is what
 *    `release.sh` has produced for 25 shipped releases and what
 *    `installBundle.test.ts`'s own "real tar/plutil round trip" describe
 *    block already builds fixtures with -- reusing it here rather than a
 *    second, builder-native implementation keeps there being exactly ONE
 *    tar-shape contract in this repo instead of two that could drift apart.
 *
 * `COPYFILE_DISABLE=1` is load-bearing, not decorative: without it, macOS's
 * bsdtar writes an AppleDouble `._*` sidecar entry for every file carrying
 * extended attributes (which, post-codesign, is nearly everything in the
 * bundle) -- including a `._Arcelle.app` entry FIRST in the archive, ahead of
 * the real `Arcelle.app` directory. `extractTarGz` (`installBundle.ts`) is
 * not AppleDouble-aware and its `--strip-components=1` extraction would land
 * on that bogus entry; see `installBundle.test.ts`'s
 * "a payload packed WITHOUT COPYFILE_DISABLE really does carry ._Arcelle.app"
 * test for the failure this prevents, reproduced fresh in
 * `packTarGz_a.test.mjs` below against THIS module's own output.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @param {object} opts
 * @param {string} opts.appPath - absolute path to the built `.app` (its
 *   basename, e.g. `Arcelle.app`, becomes the archive's sole top-level entry).
 * @param {string} opts.outFile - absolute destination path for the `.tar.gz`.
 * @param {string} [opts.tarBinary] - defaults to `/usr/bin/tar` (the system
 *   bsdtar `extractTarGz` and every shipped Tauri client also assume).
 * @param {(cmd: string, args: string[], options: object) => Promise<unknown>} [opts.execFn]
 *   Injectable for tests; defaults to a real `execFile`.
 * @returns {Promise<string>} `opts.outFile`, once written.
 */
export async function packTarGz({ appPath, outFile, tarBinary = "/usr/bin/tar", execFn = execFileAsync }) {
  const dir = path.dirname(appPath);
  const base = path.basename(appPath);
  if (!base.endsWith(".app")) {
    // Not a hard technical requirement of tar itself, but every consumer of
    // this archive (extractTarGz's Contents/MacOS post-condition,
    // readCFBundleExecutable, restart_macos_app on the OLD Tauri client) is
    // written assuming the sole top-level entry is a `.app` bundle -- failing
    // loudly here is cheaper than a bridge release silently shipping
    // something an old client's updater cannot install.
    throw new Error(`packTarGz: appPath must name a *.app bundle, got: ${appPath}`);
  }
  await execFn(tarBinary, ["-czf", outFile, "-C", dir, base], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return outFile;
}

// CLI: node packTarGz.mjs <appPath> <outFile>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [appPath, outFile] = process.argv.slice(2);
  if (!appPath || !outFile) {
    console.error("usage: node packTarGz.mjs <path/to/Arcelle.app> <path/to/Arcelle.app.tar.gz>");
    process.exit(2);
  }
  await packTarGz({ appPath: path.resolve(appPath), outFile: path.resolve(outFile) });
  console.log(`wrote ${outFile}`);
}

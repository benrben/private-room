/**
 * Proof for `afterSignCore_a.mjs` WITHOUT ever invoking a real `codesign` --
 * every `exec` call is captured against a scripted fake, so this asserts the
 * exact command shape and ordering rather than any live signing outcome.
 * (Real `codesign` behaviour, including whether `--sign - --timestamp` fails
 * or no-ops, is verification item #2 in the research doc and stays open;
 * nothing here or elsewhere in this candidate performs a real sign, ad-hoc or
 * otherwise, per this batch's safety rules.)
 */
import { describe, expect, it } from "vitest";
import {
  APP_IDENTIFIER,
  DESIGNATED_REQUIREMENT,
  parseCodesignInfo,
  resignSidecarAndReseal,
} from "./afterSignCore.mjs";

function fakeExec(script) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, result] of script) {
      if (pattern.test(key)) return result ?? { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const AD_HOC_DV = {
  stdout: "",
  stderr: [
    "Executable=/tmp/Arcelle.app/Contents/MacOS/Arcelle",
    "Identifier=com.benreich.privateroom",
    "Format=app bundle with Mach-O thin (arm64)",
    "Signature=adhoc",
    "TeamIdentifier=not set",
  ].join("\n"),
};

const REAL_DV = {
  stdout: "",
  stderr: [
    "Executable=/tmp/Arcelle.app/Contents/MacOS/Arcelle",
    "Identifier=com.benreich.privateroom",
    'Authority=Developer ID Application: Ben Reich (ABCDE12345)',
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=ABCDE12345",
  ].join("\n"),
};

describe("parseCodesignInfo", () => {
  it("reads an ad-hoc signature as ad-hoc (TeamIdentifier=not set has no uppercase run)", () => {
    const info = parseCodesignInfo(`${AD_HOC_DV.stdout}\n${AD_HOC_DV.stderr}`);
    expect(info.isAdHoc).toBe(true);
    expect(info.teamIdentifier).toBeNull();
    expect(info.identity).toBe("-");
  });

  it("reads a real certificate's TeamIdentifier and first Authority= line", () => {
    const info = parseCodesignInfo(`${REAL_DV.stdout}\n${REAL_DV.stderr}`);
    expect(info.isAdHoc).toBe(false);
    expect(info.teamIdentifier).toBe("ABCDE12345");
    expect(info.identity).toBe("Developer ID Application: Ben Reich (ABCDE12345)");
  });
});

describe("resignSidecarAndReseal — ad-hoc path", () => {
  it("signs the sidecar, then reseals top-level WITH the explicit requirements + --timestamp=none, in that order", async () => {
    const { exec, calls } = fakeExec([
      [/^codesign -dv /, AD_HOC_DV],
      [/^codesign -d -r- /, { stdout: `designated => identifier "${APP_IDENTIFIER}"\n`, stderr: "" }],
    ]);

    const result = await resignSidecarAndReseal({
      appPath: "/tmp/Arcelle.app",
      sidecarExecutablePath: "/tmp/Arcelle.app/Contents/Resources/sidecar/arcelle-sidecar/arcelle-sidecar",
      sidecarEntitlementsPath: "/repo/sidecar/sidecar-entitlements.plist",
      appEntitlementsPath: "/repo/scripts/entitlements.mac_a.plist",
      adHocFrameworks: [
        "/tmp/Arcelle.app/Contents/Frameworks/Electron Framework.framework",
      ],
      adHocHelpers: [
        { path: "/tmp/Arcelle.app/Contents/Frameworks/Arcelle Helper (Renderer).app", entitlementsPath: "/osx-sign/default.darwin.renderer.plist" },
      ],
      exec,
    });

    expect(result).toEqual({ isAdHoc: true, identity: "-" });

    // Ordering: introspect -> framework + helper bundle seals -> sidecar -> top
    // reseal -> verify -> DR check.
    const cmds = calls.map((c) => c.join(" "));
    expect(cmds[0]).toMatch(/^codesign -dv \/tmp\/Arcelle\.app$/);
    expect(cmds[1]).toBe(
      "codesign --force --sign - --timestamp=none " +
        "/tmp/Arcelle.app/Contents/Frameworks/Electron Framework.framework",
    );
    expect(cmds[2]).toBe(
      "codesign --force --entitlements /osx-sign/default.darwin.renderer.plist --sign - --timestamp=none " +
        "/tmp/Arcelle.app/Contents/Frameworks/Arcelle Helper (Renderer).app",
    );
    expect(cmds[3]).toBe(
      "codesign --force --entitlements /repo/sidecar/sidecar-entitlements.plist --sign - --timestamp=none " +
        "/tmp/Arcelle.app/Contents/Resources/sidecar/arcelle-sidecar/arcelle-sidecar",
    );
    expect(cmds[4]).toBe(
      `codesign --force --sign - --identifier ${APP_IDENTIFIER} ` +
        `--entitlements /repo/scripts/entitlements.mac_a.plist --requirements ${DESIGNATED_REQUIREMENT} --timestamp=none /tmp/Arcelle.app`,
    );
    expect(cmds[5]).toBe("codesign --verify --strict --deep /tmp/Arcelle.app");
    expect(cmds[6]).toBe("codesign -d -r- /tmp/Arcelle.app");
    // No --deep anywhere on a SIGN call (only on verify, cmds[5]).
    for (const c of [cmds[1], cmds[2], cmds[3], cmds[4]]) expect(c).not.toMatch(/--deep/);
  });

  it("throws if the embedded designated requirement does not come back on readback", async () => {
    const { exec } = fakeExec([
      [/^codesign -dv /, AD_HOC_DV],
      [/^codesign -d -r- /, { stdout: "designated => anchor apple generic\n", stderr: "" }],
    ]);
    await expect(
      resignSidecarAndReseal({
        appPath: "/tmp/Arcelle.app",
        sidecarExecutablePath: null,
        sidecarEntitlementsPath: "/repo/sidecar/sidecar-entitlements.plist",
        appEntitlementsPath: "/repo/scripts/entitlements.mac_a.plist",
        exec,
      }),
    ).rejects.toThrow(/designated requirement not embedded/);
  });
});

describe("resignSidecarAndReseal — real Developer ID path", () => {
  it("still signs the sidecar (CPython needs its entitlements regardless of identity kind), but the reseal has NO --requirements and uses --timestamp, reusing the resolved Authority= identity", async () => {
    const { exec, calls } = fakeExec([[/^codesign -dv /, REAL_DV]]);

    const result = await resignSidecarAndReseal({
      appPath: "/tmp/Arcelle.app",
      sidecarExecutablePath: "/tmp/Arcelle.app/Contents/Resources/sidecar/arcelle-sidecar/arcelle-sidecar",
      sidecarEntitlementsPath: "/repo/sidecar/sidecar-entitlements.plist",
      appEntitlementsPath: "/repo/scripts/entitlements.mac_a.plist",
      exec,
    });

    expect(result).toEqual({
      isAdHoc: false,
      identity: "Developer ID Application: Ben Reich (ABCDE12345)",
    });

    const cmds = calls.map((c) => c.join(" "));
    expect(cmds[1]).toBe(
      'codesign --force --options runtime --entitlements /repo/sidecar/sidecar-entitlements.plist ' +
        '--sign Developer ID Application: Ben Reich (ABCDE12345) --timestamp ' +
        "/tmp/Arcelle.app/Contents/Resources/sidecar/arcelle-sidecar/arcelle-sidecar",
    );
    expect(cmds[2]).toBe(
      `codesign --force --sign Developer ID Application: Ben Reich (ABCDE12345) --identifier ${APP_IDENTIFIER} ` +
        "--options runtime --entitlements /repo/scripts/entitlements.mac_a.plist --timestamp /tmp/Arcelle.app",
    );
    expect(cmds[2]).not.toMatch(/--requirements/);
    // dv, sidecar resign, top reseal, verify --deep -- no DR readback on the
    // real-cert path (nothing to assert; the cert supplies its own DR).
    expect(cmds).toHaveLength(4);
    expect(cmds[3]).toBe("codesign --verify --strict --deep /tmp/Arcelle.app");
  });

  it("skips the sidecar step (not fails) when this build has no bundled sidecar", async () => {
    const { exec, calls } = fakeExec([[/^codesign -dv /, REAL_DV]]);
    await resignSidecarAndReseal({
      appPath: "/tmp/Arcelle.app",
      sidecarExecutablePath: null,
      sidecarEntitlementsPath: "/repo/sidecar/sidecar-entitlements.plist",
      appEntitlementsPath: "/repo/scripts/entitlements.mac_a.plist",
      exec,
    });
    const cmds = calls.map((c) => c.join(" "));
    expect(cmds.some((c) => c.includes("sidecar-entitlements"))).toBe(false);
    // dv, top reseal, verify --deep -- no sidecar resign (skipped), no DR
    // readback (real-cert path never does one).
    expect(cmds).toHaveLength(3);
    expect(cmds[2]).toBe("codesign --verify --strict --deep /tmp/Arcelle.app");
  });
});

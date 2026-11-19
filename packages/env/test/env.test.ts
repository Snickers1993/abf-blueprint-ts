import { test } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import {
  AbfcError,
  assertNotInModFolder,
  checkHeadlessDir,
  checkNode,
  editorFingerprint,
  editorFingerprints,
  sameEditorBuild,
  exitCodeFor,
  findBackendDir,
  findDocuments,
  findEditorRoot,
  findHeadlessDir,
  findProjectDir,
  findPython,
  formatDiagnostic,
  loadProfile,
  loadProjectConfig,
  profileForBuild,
  resolveEnvironment,
} from "../src/index.js";
import { fakeHost } from "./fakehost.js";

const profile = loadProfile();
const exeRel = profile.exeRelPath;
const exeAt = (root: string): string => win32.join(root, exeRel);
const MANIFEST_DIR = "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests";

function manifest(install: string, version = `build-${profile.buildTag}`): Record<string, string> {
  return {
    [`${MANIFEST_DIR}\\A1.item`]: JSON.stringify({ DisplayName: profile.editorDisplayName, InstallLocation: install, AppVersionString: version }),
  };
}

function editorHost(env: NodeJS.ProcessEnv, roots: string[], extraFiles: Record<string, string> = {}) {
  const files: Record<string, string> = { ...extraFiles };
  for (const r of roots) files[exeAt(r)] = "exe";
  return fakeHost({ env: { ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files", ...env }, files });
}

// ------------------------------------------------------------------ editor root precedence

test("editor root: flag > ABFC_ > ABF_ > project > user > manifest > Program Files", () => {
  const pf = "C:\\Program Files\\Epic Games\\ModEdit_Suffix";
  const roots = ["D:\\flag", "D:\\envA", "D:\\envB", "D:\\proj", "D:\\user", "C:\\Epic\\Install_1", pf];
  // The profile glob prefix decides which Program Files folder name matches.
  const glob = profile.programFilesGlob;
  const prefix = glob.slice(glob.lastIndexOf("\\") + 1).replace(/\*$/, "");
  const pfReal = `C:\\Program Files\\Epic Games\\${prefix}_Suffix`;
  roots[roots.indexOf(pf)] = pfReal;

  const env = { ABFC_EDITOR_ROOT: "D:\\envA", ABF_EDITOR_ROOT: "D:\\envB" };
  const mkReal = (e: NodeJS.ProcessEnv, withManifest: boolean, withPf: boolean) =>
    editorHost(e, roots.filter((r) => (r === pfReal ? withPf : true)), withManifest ? manifest("C:\\Epic\\Install_1") : {});

  let r = findEditorRoot(mkReal(env, true, true), profile, "D:\\flag", "D:\\proj", "D:\\user");
  assert.deepEqual([r.value, r.source], ["D:\\flag", "flag"]);

  r = findEditorRoot(mkReal(env, true, true), profile, undefined, "D:\\proj", "D:\\user");
  assert.deepEqual([r.value, r.source], ["D:\\envA", "env"]);

  r = findEditorRoot(mkReal({ ABF_EDITOR_ROOT: "D:\\envB" }, true, true), profile, undefined, "D:\\proj", "D:\\user");
  assert.deepEqual([r.value, r.source], ["D:\\envB", "env"]);

  r = findEditorRoot(mkReal({}, true, true), profile, undefined, "D:\\proj", "D:\\user");
  assert.deepEqual([r.value, r.source], ["D:\\proj", "project"]);

  r = findEditorRoot(mkReal({}, true, true), profile, undefined, undefined, "D:\\user");
  assert.deepEqual([r.value, r.source], ["D:\\user", "user"]);

  r = findEditorRoot(mkReal({}, true, true), profile);
  assert.deepEqual([r.value, r.source], ["C:\\Epic\\Install_1", "auto"]);
  assert.equal(r.appVersion, `build-${profile.buildTag}`);
  assert.deepEqual(
    r.tried.map((t) => t.source),
    ["--editor-root", "ABFC_EDITOR_ROOT", "ABF_EDITOR_ROOT", "abf.config.json", "%APPDATA%\\abfc\\config.json", "Epic manifests"],
  );

  r = findEditorRoot(mkReal({}, false, true), profile);
  assert.deepEqual([r.value, r.source], [pfReal, "auto"]);
  assert.equal(r.appVersion, null);
  assert.ok(r.tried.some((t) => t.source === "Epic manifests"));
  assert.ok(r.tried.some((t) => t.source === "Program Files wildcard"));
});

test("editor root: an explicit root without the exe falls through, and a total miss is ABFC1001 with every source", () => {
  const host = editorHost({}, ["D:\\user"]);
  const r = findEditorRoot(host, profile, "D:\\nothing", undefined, "D:\\user");
  assert.equal(r.value, "D:\\user");
  assert.match(r.tried[0]!.detail, /D:\\nothing \(no .* there\)/);

  const none = editorHost({}, []);
  assert.throws(
    () => findEditorRoot(none, profile),
    (e: unknown) => {
      assert.ok(e instanceof AbfcError);
      assert.equal(e.diagnostic.code, "ABFC1001");
      assert.equal(e.exitCode, 2);
      const sources = e.diagnostic.tried!.map((t) => t.source);
      for (const s of ["--editor-root", "ABFC_EDITOR_ROOT", "ABF_EDITOR_ROOT", "abf.config.json", "Epic manifests", "Program Files wildcard"]) {
        assert.ok(sources.includes(s), s);
      }
      return true;
    },
  );
});

test("profileForBuild matches the build tag and rejects unknown builds", () => {
  assert.equal(profileForBuild(`x-${profile.buildTag}-y`)?.id, profile.id);
  assert.equal(profileForBuild("0.0.0-unknown"), null);
  assert.equal(profileForBuild(null), null);
});

test("editorFingerprint changes with the exe, not with the launcher's app version", () => {
  const root = "D:\\ed";
  const a = fakeHost({ files: { [exeAt(root)]: "aaaa" } });
  const b = fakeHost({ files: { [exeAt(root)]: "aaaaaa" } });
  const f1 = editorFingerprint(a, root, profile, "v1");
  assert.equal(f1, editorFingerprint(a, root, profile, "v1"));
  assert.notEqual(f1, editorFingerprint(b, root, profile, "v1"));
  // the launcher writing a version into its manifest (or changing it) is not a new editor build
  assert.equal(f1, editorFingerprint(a, root, profile, "v2"));
  assert.equal(f1, editorFingerprint(a, root, profile, null));
  // what earlier versions recorded with a version still counts as this build
  const [fp, ...aliases] = editorFingerprints(a, root, profile, "v1");
  assert.equal(fp, f1);
  assert.equal(aliases.length, 1);
  assert.ok(sameEditorBuild({ fingerprint: fp!, fingerprintAliases: aliases }, aliases[0]));
  assert.ok(sameEditorBuild({ fingerprint: fp!, fingerprintAliases: aliases }, f1));
  assert.ok(!sameEditorBuild({ fingerprint: fp!, fingerprintAliases: aliases }, editorFingerprint(b, root, profile, "v1")));
  assert.ok(sameEditorBuild({ fingerprint: null }, "anything"));
});

// ------------------------------------------------------------------ Documents

function regOut(value: string, type = "REG_EXPAND_SZ"): { status: number; stdout: string } {
  return {
    status: 0,
    stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Personal    ${type}    ${value}\r\n\r\n`,
  };
}

test("Documents: expands %USERPROFILE% with a space in the user name (never guesses the default)", () => {
  const host = fakeHost({
    env: { USERPROFILE: "C:\\Users\\Jane Doe" },
    run: (cmd, args) => (cmd === "reg" && args.includes("Personal") ? regOut("%USERPROFILE%\\OneDrive\\Documents") : undefined),
  });
  const r = findDocuments(host);
  assert.equal(r.value, "C:\\Users\\Jane Doe\\OneDrive\\Documents");
  assert.ok(host.calls[0]!.startsWith("reg query"));
});

test("Documents: a plain redirected path resolves as is; env lookup is case-insensitive", () => {
  const plain = fakeHost({ run: () => regOut("D:\\Docs", "REG_SZ") });
  assert.equal(findDocuments(plain).value, "D:\\Docs");
  const ci = fakeHost({ env: { userprofile: "E:\\u" }, run: () => regOut("%USERPROFILE%\\Documents") });
  assert.equal(findDocuments(ci).value, "E:\\u\\Documents");
});

test("Documents: registry failure is ABFC1002", () => {
  const host = fakeHost({ run: () => ({ status: 1 }) });
  assert.throws(
    () => findDocuments(host),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1002" && e.exitCode === 2,
  );
});

// ------------------------------------------------------------------ Headless dir

test("headless dir: user name with a space gives ABFC1012 naming the path; ABF_HEADLESS_DIR fixes it", () => {
  const local = "C:\\Users\\Jane Doe\\AppData\\Local";
  const host = fakeHost({ env: { LOCALAPPDATA: local } });
  const r = findHeadlessDir(host, profile);
  assert.equal(r.value, win32.join(local, profile.defaultHeadlessSubdir));
  const d = checkHeadlessDir(r.value!);
  assert.equal(d?.code, "ABFC1012");
  assert.equal(d?.severity, "error");
  assert.ok(d!.message.includes(`"${r.value}"`));
  assert.ok(d!.message.includes("C:\\abfc-headless"));
  assert.ok(d!.message.includes("ABF_HEADLESS_DIR"));

  const fixed = findHeadlessDir(fakeHost({ env: { LOCALAPPDATA: local, ABF_HEADLESS_DIR: "C:\\abfc-headless" } }), profile);
  assert.deepEqual([fixed.value, fixed.source], ["C:\\abfc-headless", "env"]);
  assert.equal(checkHeadlessDir(fixed.value!), null);
});

test("headless dir: non-ASCII is a warning", () => {
  const d = checkHeadlessDir("C:\\Users\\J\u00fcrgen\\AppData\\Local\\x");
  assert.equal(d?.code, "ABFC1013");
  assert.equal(d?.severity, "warning");
});

test("node: only major 24 is silent", () => {
  assert.equal(checkNode(fakeHost({ nodeVersion: "v24.3.1" })), null);
  assert.equal(checkNode(fakeHost({ nodeVersion: "v26.7.0" }))?.code, "ABFC1030");
});

// ------------------------------------------------------------------ Python

const PY_VER = /print\('%d\.%d'/;
function pythonRun(table: { launcher?: string; plain?: string; versions: Record<string, string> }) {
  return (cmd: string, args: string[]) => {
    if (args.some((a) => PY_VER.test(a))) {
      const v = table.versions[cmd];
      return v === undefined ? { status: 1 } : { status: 0, stdout: `${v}\r\n` };
    }
    if (cmd === "py" && table.launcher) return { status: 0, stdout: `${table.launcher}\r\n` };
    if (cmd === "python" && table.plain) return { status: 0, stdout: `${table.plain}\r\n` };
    return { status: 1 };
  };
}

test("python: py -3 launcher is tried first", () => {
  const host = fakeHost({
    run: pythonRun({
      launcher: "C:\\Py\\py311\\python.exe",
      plain: "C:\\Py\\other\\python.exe",
      versions: { "C:\\Py\\py311\\python.exe": "3.11", "C:\\Py\\other\\python.exe": "3.12" },
    }),
  });
  const r = findPython(host);
  assert.equal(r.value, "C:\\Py\\py311\\python.exe");
  assert.equal(r.version, "3.11");
  assert.equal(host.calls[0], "py -3 -c import sys;print(sys.executable)");
});

test("python: the Store alias is refused, then the next candidate is used", () => {
  const store = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";
  const host = fakeHost({
    run: pythonRun({ launcher: store, plain: "C:\\Py\\ok\\python.exe", versions: { [store]: "3.12", "C:\\Py\\ok\\python.exe": "3.10" } }),
  });
  const r = findPython(host);
  assert.equal(r.value, "C:\\Py\\ok\\python.exe");
  assert.ok(r.tried.some((t) => /Store alias/.test(t.detail)));
});

test("python: 3.8 is refused (ABFC1005 when nothing else is left)", () => {
  const old = "C:\\Py\\py38\\python.exe";
  const host = fakeHost({ run: pythonRun({ launcher: old, versions: { [old]: "3.8" } }) });
  assert.throws(
    () => findPython(host),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1005" && e.diagnostic.tried!.some((t) => /older than 3\.9/.test(t.detail)),
  );
});

test("python: an explicit flag wins over auto-discovery", () => {
  const host = fakeHost({ run: pythonRun({ launcher: "C:\\Py\\auto\\python.exe", versions: { "D:\\mine\\python.exe": "3.13", "C:\\Py\\auto\\python.exe": "3.11" } }) });
  const r = findPython(host, "D:\\mine\\python.exe");
  assert.deepEqual([r.value, r.source, r.version], ["D:\\mine\\python.exe", "flag", "3.13"]);
});

// ------------------------------------------------------------------ backend dir, project dir

test("backend dir needs an explicit folder with server.py (ABFC1006)", () => {
  const host = fakeHost({ files: { "D:\\mcp\\server.py": "" } });
  assert.equal(findBackendDir(host, "D:\\mcp").value, "D:\\mcp");
  assert.throws(
    () => findBackendDir(host),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1006" && /ABFC_BACKEND_DIR/.test(e.diagnostic.fix!),
  );
});

test("findProjectDir walks up to abf.config.json", () => {
  const host = fakeHost({ files: { "D:\\work\\proj\\abf.config.json": "{}" }, dirs: ["D:\\work\\proj\\src\\deep"] });
  assert.equal(findProjectDir("D:\\work\\proj\\src\\deep", (p) => host.exists(p)), "D:\\work\\proj");
  assert.throws(
    () => findProjectDir("D:\\work\\elsewhere", (p) => host.exists(p)),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1021",
  );
});

test("assertNotInModFolder refuses a dir under a folder holding a .uplugin (ABFC1020, exit 3)", () => {
  const host = fakeHost({
    files: { "D:\\Mods\\x\\x.uplugin": "{}" },
    dirs: ["D:\\Mods\\x\\ts\\project", "D:\\outside\\project"],
  });
  assert.throws(
    () => assertNotInModFolder(host, "D:\\Mods\\x\\ts\\project"),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1020" && e.exitCode === 3,
  );
  assert.throws(() => assertNotInModFolder(host, "D:\\Mods\\x"), AbfcError);
  assert.doesNotThrow(() => assertNotInModFolder(host, "D:\\outside\\project"));
});

// ------------------------------------------------------------------ config

test("loadProjectConfig: BOM tolerated, defaults filled, bad key reported with its JSON path (ABFC1021)", () => {
  const dir = "D:\\p";
  const ok = fakeHost({ files: { [`${dir}\\abf.config.json`]: "\uFEFF" + JSON.stringify({ mod: { name: "m" }, editor: { root: "D:\\e" } }) } });
  const cfg = loadProjectConfig(dir, ok);
  assert.equal(cfg.mod.name, "m");
  assert.deepEqual(cfg.stubs, { classes: [], scriptClasses: [], modAssets: "all", widgetMembers: {} });
  assert.deepEqual(cfg.backend, { kind: "bp_apply", minProtocol: 1 });
  assert.equal(cfg.editor?.root, "D:\\e");

  const bad = fakeHost({ files: { [`${dir}\\abf.config.json`]: JSON.stringify({ mod: { name: "m" }, stubs: { classes: "nope" } }) } });
  assert.throws(
    () => loadProjectConfig(dir, bad),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1021" && /stubs\.classes/.test(e.diagnostic.message),
  );
  assert.throws(() => loadProjectConfig(dir, fakeHost()), (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1021");
});

test("exitCodeFor: publish codes", () => {
  assert.equal(exitCodeFor("ABFC7004"), 1);
  assert.equal(exitCodeFor("ABFC7005"), 3);
  assert.equal(exitCodeFor("ABFC7006"), 2);
  assert.equal(exitCodeFor("ABFC4090"), 3);
});

test("exitCodeFor: init codes", () => {
  for (const c of ["ABFC1040", "ABFC1041", "ABFC1042", "ABFC1044"]) assert.equal(exitCodeFor(c), 1, c);
  assert.equal(exitCodeFor("ABFC1001"), 2);
  assert.equal(exitCodeFor("ABFC1020"), 3);
});

// ------------------------------------------------------------------ resolveEnvironment

test("resolveEnvironment: full discovery for a user name with a space and redirected Documents", () => {
  const user = "C:\\Users\\Jane Doe";
  const proj = "D:\\work\\proj";
  const docs = "E:\\Redirected\\Documents";
  const editor = "C:\\Epic\\Install_1";
  const modsDir = win32.join(docs, profile.modsFolderName);
  const host = fakeHost({
    env: {
      ProgramData: "C:\\ProgramData",
      USERPROFILE: user,
      LOCALAPPDATA: `${user}\\AppData\\Local`,
      ABFC_BACKEND_DIR: "D:\\mcp",
    },
    files: {
      [`${proj}\\abf.config.json`]: JSON.stringify({ mod: { name: "fakemod" } }),
      [`${modsDir}\\fakemod\\fakemod.uplugin`]: "{}",
      [exeAt(editor)]: "exe",
      "D:\\mcp\\server.py": "",
      ...manifest(editor),
    },
    run: (cmd, args) => {
      if (cmd === "reg") return regOut("E:\\Redirected\\Documents", "REG_SZ");
      return pythonRun({ launcher: "C:\\Py\\python.exe", versions: { "C:\\Py\\python.exe": "3.11" } })(cmd, args);
    },
  });
  const e = resolveEnvironment(host, { projectDir: proj, flags: {} });
  assert.equal(e.documents.value, docs);
  assert.equal(e.editorRoot.value, editor);
  assert.equal(e.modDir.value, win32.join(modsDir, "fakemod"));
  assert.equal(e.python.value, "C:\\Py\\python.exe");
  assert.equal(e.backendDir.value, "D:\\mcp");
  assert.equal(e.profile.id, profile.id);
  assert.match(e.fingerprint!, /^[0-9a-f]{64}$/);
  const codes = e.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("ABFC1012"), codes.join());
  assert.ok(!codes.includes("ABFC1001"));
});

test("resolveEnvironment: a user config holding only mod.dir resolves modDir with source user", () => {
  const proj = "D:\\work\\proj";
  const appData = "C:\\Users\\Jane\\AppData\\Roaming";
  const modDir = "F:\\custom\\fakemod";
  const host = fakeHost({
    env: { ProgramData: "C:\\ProgramData", APPDATA: appData },
    files: {
      [`${proj}\\abf.config.json`]: JSON.stringify({ mod: { name: "fakemod" } }),
      [`${appData}\\abfc\\config.json`]: JSON.stringify({ mod: { dir: modDir } }),
      [`${modDir}\\fakemod.uplugin`]: "{}",
    },
  });
  const e = resolveEnvironment(host, { projectDir: proj, flags: {} });
  assert.equal(e.modDir.value, modDir);
  assert.equal(e.modDir.source, "user");
  assert.equal(e.config.mod.name, "fakemod");
});

test("resolveEnvironment: mod.name in another case than the plugin file warns ABFC1045 and uses the plugin's spelling", () => {
  const proj = "D:\\work\\proj";
  const appData = "C:\\Users\\Jane\\AppData\\Roaming";
  const modDir = "F:\\custom\\TestMod";
  const files = (name: string): Record<string, string> => ({
    [`${proj}\\abf.config.json`]: JSON.stringify({ mod: { name } }),
    [`${appData}\\abfc\\config.json`]: JSON.stringify({ mod: { dir: modDir } }),
    [`${modDir}\\TestMod.uplugin`]: "{}",
  });
  const lower = resolveEnvironment(fakeHost({ env: { ProgramData: "C:\\ProgramData", APPDATA: appData }, files: files("testmod") }), {
    projectDir: proj,
    flags: {},
  });
  assert.equal(lower.config.mod.name, "TestMod");
  const d = lower.diagnostics.find((x) => x.code === "ABFC1045");
  assert.ok(d, lower.diagnostics.map((x) => x.code).join());
  assert.equal(d!.severity, "warning");
  assert.match(d!.message, /"testmod" differs in case from the mod's plugin "TestMod"; using "TestMod"/);
  assert.match(d!.fix ?? "", /"mod": \{"name": "TestMod"\}/);
  const same = resolveEnvironment(fakeHost({ env: { ProgramData: "C:\\ProgramData", APPDATA: appData }, files: files("TestMod") }), {
    projectDir: proj,
    flags: {},
  });
  assert.equal(same.config.mod.name, "TestMod");
  assert.ok(!same.diagnostics.some((x) => x.code === "ABFC1045"));
});

test("resolveEnvironment: a project inside a mod folder throws ABFC1020 before anything else", () => {
  const host = fakeHost({
    files: { "D:\\Mods\\m\\m.uplugin": "{}", "D:\\Mods\\m\\ts\\abf.config.json": JSON.stringify({ mod: { name: "m" } }) },
  });
  assert.throws(
    () => resolveEnvironment(host, { projectDir: "D:\\Mods\\m\\ts", flags: {} }),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1020" && e.exitCode === 3,
  );
});

// ------------------------------------------------------------------ diagnostics format

test("formatDiagnostic: environment layout (design 9.3)", () => {
  const text = formatDiagnostic({
    severity: "error",
    code: "ABFC1001",
    message: "Editor not found.",
    tried: [
      { source: "--editor-root", detail: "not given" },
      { source: "%APPDATA%\\abfc\\config.json", detail: "editor.root not set" },
    ],
    fix: "install it.",
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "abfc: error ABFC1001: Editor not found.");
  assert.equal(lines[1], "  tried:");
  assert.equal(lines[2], `    ${"--editor-root".padEnd(28)} not given`);
  assert.equal(lines[3], `    ${"%APPDATA%\\abfc\\config.json".padEnd(28)} editor.root not set`);
  assert.equal(lines[4], "  fix: install it.");
});

test("formatDiagnostic: a span prints the problem-matcher form with a forward-slash relative path", () => {
  const text = formatDiagnostic(
    { severity: "error", code: "ABFC2000", message: "[TS2322] Type mismatch", span: { file: "D:\\work\\proj\\src\\a.ts", line: 12, col: 5, endLine: 12, endCol: 9 } },
    "D:\\work\\proj",
  );
  assert.equal(text, "src/a.ts:12:5: error ABFC2000: [TS2322] Type mismatch");
  const m = /^(.*\.ts):(\d+):(\d+): (error|warning) (ABFC\d+): (.*)$/.exec(text);
  assert.ok(m);
  assert.deepEqual([m[2], m[3], m[5]], ["12", "5", "ABFC2000"]);
});

test("loadProjectConfig: stubs.widgetMembers is validated (ABFC1021)", () => {
  const dir = "D:\\p";
  const cfgOf = (widgetMembers: unknown) =>
    fakeHost({ files: { [`${dir}\\abf.config.json`]: JSON.stringify({ mod: { name: "m" }, stubs: { widgetMembers } }) } });
  const good = { "/Game/UI/W_Example.W_Example_C": { TitleText: "/Script/UMG.TextBlock" } };
  assert.deepEqual(loadProjectConfig(dir, cfgOf(good)).stubs.widgetMembers, good);
  for (const bad of [["x"], { "/Game/X.X_C": "TextBlock" }, { "/Game/X.X_C": { A: 3 } }, { "/Game/X.X_C": { A: "TextBlock" } }]) {
    assert.throws(
      () => loadProjectConfig(dir, cfgOf(bad)),
      (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1021" && /stubs\.widgetMembers/.test(e.diagnostic.message),
    );
  }
});

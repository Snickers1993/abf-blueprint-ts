import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AbfcError } from "@abfc/env";
import { ALLOWED_TOOLS, McpStdioClient, assertToolAllowed, backendServerEnv, grantPublish } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/fake-server.mjs", import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withClient(
  extraEnv: Record<string, string>,
  fn: (c: McpStdioClient, logFile: string) => Promise<void>,
  closeGraceMs = 5000,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "abfc-mcp-test-"));
  const logFile = join(dir, "received.log");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { ...env, FAKE_LOG: logFile, ...extraEnv },
    requestTimeoutMs: 5000,
    closeGraceMs,
  });
  try {
    await fn(client, logFile);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const received = (logFile: string): Array<{ method: string; tool?: string }> =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method: string; tool?: string })
    : [];

test("initialize handshake and tools/list (stray lines are ignored)", async () => {
  await withClient({}, async (c, logFile) => {
    assert.deepEqual(await c.listTools(), ["backend_info", "echo", "bp_publish", "slow"]);
    const methods = received(logFile).map((r) => r.method);
    assert.deepEqual(methods.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
  });
});

test("callTool parses JSON text and reports timing", async () => {
  await withClient({}, async (c) => {
    const r = await c.callTool("backend_info", {});
    assert.equal(r.isError, false);
    assert.equal((r.json as { protocol: number }).protocol, 1);
    assert.equal(typeof r.wallSeconds, "number");
    assert.match(r.text, /"serverVersion":"fake-1"/);

    const plain = await c.callTool("backend_info", { plain: true });
    assert.equal(plain.json, undefined);
    assert.equal(plain.text, "not json");

    const bad = await c.callTool("backend_info", { fail: true });
    assert.equal(bad.isError, true);
    assert.equal(bad.text, "boom");
  });
});

test("bp_publish and tools off the allowlist are refused before any message is sent", async () => {
  await withClient({}, async (c, logFile) => {
    for (const tool of ["bp_publish", "echo"]) {
      await assert.rejects(
        c.callTool(tool, { x: 1 }),
        (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC4090" && e.exitCode === 3 && e.diagnostic.message.includes(tool),
      );
    }
    assert.equal(received(logFile).filter((r) => r.method === "tools/call").length, 0);
    await c.callTool("backend_info", {});
    assert.equal(received(logFile).filter((r) => r.method === "tools/call").length, 1);
  });
});

test("assertToolAllowed accepts exactly the allowlist", () => {
  for (const t of ALLOWED_TOOLS) assert.doesNotThrow(() => assertToolAllowed(t));
  assert.equal(ALLOWED_TOOLS.length, 14);
  assert.throws(() => assertToolAllowed("bp_publish"), AbfcError);
  assert.throws(() => assertToolAllowed("run_python"), AbfcError);
});

const is4090 = (e: unknown): boolean => e instanceof AbfcError && e.diagnostic.code === "ABFC4090" && e.exitCode === 3;

test("bp_publish: refused without a grant, with a forged grant, and for a different mod than the grant's (ABFC4090)", () => {
  assert.throws(() => assertToolAllowed("bp_publish"), is4090);
  assert.throws(() => assertToolAllowed("bp_publish", { args: { mod: "TestMod" } }), is4090);
  assert.throws(() => assertToolAllowed("bp_publish", { grant: { mod: "TestMod" }, args: { mod: "TestMod" } }), is4090);
  const grant = grantPublish("TestMod");
  assert.throws(() => assertToolAllowed("bp_publish", { grant, args: { mod: "OtherMod" } }), is4090);
  assert.throws(() => assertToolAllowed("bp_publish", { grant }), is4090);
  // a grant never opens any other tool that is off the allowlist
  assert.throws(() => assertToolAllowed("run_python", { grant, args: { mod: "TestMod" } }), is4090);
});

test("grantPublish mints a grant bound to one mod", () => {
  const grant = grantPublish("TestMod");
  assert.equal(grant.mod, "TestMod");
  assert.ok(Object.isFrozen(grant));
  assert.doesNotThrow(() => assertToolAllowed("bp_publish", { grant, args: { mod: "TestMod" } }));
  assert.throws(() => assertToolAllowed("bp_publish", { grant, args: { mod: "testmod" } }), is4090);
  const other = grantPublish("Other");
  assert.throws(() => assertToolAllowed("bp_publish", { grant: other, args: { mod: "TestMod" } }), is4090);
});

test("callTool sends bp_publish only with a valid grant for that mod", async () => {
  await withClient({}, async (c, logFile) => {
    await assert.rejects(c.callTool("bp_publish", { mod: "TestMod" }), is4090);
    const grant = grantPublish("TestMod");
    await assert.rejects(c.callTool("bp_publish", { mod: "OtherMod" }, { publishGrant: grant }), is4090);
    assert.equal(received(logFile).filter((r) => r.method === "tools/call").length, 0);
    // the fake server has no bp_publish handler: an RPC error (ABFC4002) proves the message was sent
    await assert.rejects(
      c.callTool("bp_publish", { mod: "TestMod" }, { publishGrant: grant }),
      (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC4002",
    );
    assert.deepEqual(received(logFile).filter((r) => r.method === "tools/call").map((r) => r.tool), ["bp_publish"]);
  });
});

test("a request that gets no reply rejects at the timeout and the client stays usable", async () => {
  await withClient({}, async (c) => {
    await assert.rejects(c.callTool("backend_info", { hang: true }, { timeoutMs: 200 }), /timed out after 200 ms/);
    const r = await c.callTool("backend_info", {});
    assert.equal((r.json as { protocol: number }).protocol, 1);
  });
});

test("close ends the process when stdin closes", async () => {
  let pid = 0;
  await withClient({}, async (c) => {
    pid = c.pid!;
    assert.ok(isAlive(pid));
    await c.close();
  });
  assert.equal(isAlive(pid), false);
});

test("close kills a process that ignores the end of stdin", async () => {
  let pid = 0;
  await withClient(
    { FAKE_IGNORE_STDIN_END: "1" },
    async (c) => {
      pid = c.pid!;
      const t0 = Date.now();
      await c.close();
      assert.ok(Date.now() - t0 < 10_000);
    },
    300,
  );
  assert.equal(isAlive(pid), false);
});

test("a server that exits rejects pending requests", async () => {
  await withClient({}, async (c) => {
    const pending = c.callTool("backend_info", { hang: true }, { timeoutMs: 10_000 });
    await c.close();
    await assert.rejects(pending, /exited/);
  });
});

test("backendServerEnv: warm true sets ABF_WARM_SESSION, warm false removes an inherited one, unset inherits", () => {
  const base = { python: "py", backendDir: "b", headlessDir: "h", editorRoot: null };
  const parent = { ABF_WARM_SESSION: "1", PATH: "p" };
  assert.equal(backendServerEnv({ ...base, warm: true }, {}).ABF_WARM_SESSION, "1");
  assert.equal("ABF_WARM_SESSION" in backendServerEnv({ ...base, warm: false }, parent), false, "--cold must stay cold");
  assert.equal(backendServerEnv({ ...base }, parent).ABF_WARM_SESSION, "1");
  const e = backendServerEnv({ ...base, warm: false, editorRoot: "E" }, parent);
  assert.deepEqual(
    [e.PATH, e.ABF_HEADLESS_DIR, e.ABF_ABFC_TOOLS, e.ABF_EDITOR_ROOT, e.PYTHONUTF8],
    ["p", "h", "1", "E", "1"],
  );
});

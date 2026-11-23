import { test } from "node:test";
import assert from "node:assert/strict";
import { publishRefusal } from "../src/commands/publish.js";

test("a live publish refused for many live instances names the preview and the closed-editor route", () => {
  const reason =
    "1140 live instances of the published classes are in the open level (BP_RTS_SendDesk x400, BP_RTS_Lamp x300), more than 300; swapping their classes live can crash the editor";
  const [d] = publishRefusal("TestMod", {
    ok: false,
    published: [],
    refused: "editor refused",
    editorReason: reason,
    message: `Refused by the open editor: /TestMod/BP_RTS_SendDesk (${reason}). Nothing was copied.`,
  } as any);
  assert.equal(d!.code, "ABFC7005");
  assert.match(d!.message, /1140 live instances/);
  assert.match(d!.fix ?? "", /runtime preview/);
  assert.match(d!.fix ?? "", /close the Mod Editor/);
});

test("a live publish refused for old copies of an earlier reload asks for a Mod Editor restart or the closed-editor route", () => {
  const reason =
    "these classes were reloaded earlier in this editor session and their old copies are still held in memory (BP_RTS_TubeStation: TRASHCLASS_BP_RTS_TubeStation_C_0); reloading them again live can crash the editor";
  const [d] = publishRefusal("TestMod", {
    ok: false,
    published: [],
    refused: "editor refused",
    editorReason: reason,
    message: `Refused by the open editor: /TestMod/BP_RTS_TubeStation (${reason}). Nothing was copied.`,
  } as any);
  assert.equal(d!.code, "ABFC7005");
  assert.match(d!.message, /TRASHCLASS_BP_RTS_TubeStation/);
  assert.match(d!.fix ?? "", /Restart the Mod Editor/);
});

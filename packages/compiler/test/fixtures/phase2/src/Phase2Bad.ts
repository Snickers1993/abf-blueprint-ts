import { blueprint, event, override, spawnActor } from "@abfc/runtime";
import type { double, float, int } from "@abfc/runtime";
import { Actor, FakeWidget } from "/Script/FakeEngine";
import { FakeSystem } from "/Script/FakeGame";
import { WBP_Panel_C } from "/Game/Fake/WBP_Panel";
import { BP_FakePot_C } from "/Game/Fake/BP_FakePot";
import type { BP_Director_Manual } from "/TestMod/Relay/BP_Director";

// Every `// ABFCnnnn` marker names a diagnostic expected on that line; `@text` is where it must start (column).

export interface BP_Wrong extends BP_Director_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Wrong" })
export class BP_Wrong extends Actor {
  @override
  NoSuchEvent(): void {} // ABFC2060 @NoSuchEvent

  @override
  override ReceiveTick(): void {} // ABFC2055 @ReceiveTick

  @event
  Mixed(i: int, d: double, f: float, w: WBP_Panel_C): void {
    const s = i + d; // ABFC2012 @i + d
    const t = i * 2;
    w.SetStyle("Weird"); // ABFC2015 ABFC2000
    const g = this.Mixed; // ABFC2054 @this.Mixed
    const k = spawnActor(BP_FakePot_C, { collisionHandlingOverride: "AlwaysSpawn", extra: 1 }); // ABFC2000 ABFC2056
  }

  @event
  Loops(w: WBP_Panel_C): void {
    FakeSystem.GetAllWidgets(WBP_Panel_C, true).push(w); // ABFC2041 @FakeSystem
    this.Pots.splice(0, 2); // ABFC2099 @this.Pots.splice(0, 2)
    this.Pots.length = 1; // ABFC2099 @1;
    for (let k = this.Elapsed; k < 2; k++) {} // ABFC2012 @this.Elapsed
    for (let n = 0; n < 3; n += 2) {} // ABFC2099 @n += 2
    const t = this.Pots.length > 0 ? 1 : 2; // ABFC2099
    let x = 1; // ABFC2099
    this.Pots.forEach(function (p) {}); // ABFC2090 @function
    this.Pots.forEach((p) => p); // ABFC2090
    this.Pots.forEach((p, i, all) => {}); // ABFC2090 @all
    this.Pots.forEach((p) => {}, this); // ABFC2090
    this.Pots.forEach(async (p) => {}); // ABFC2090
    this.Pots.forEach((p) => { if (this.Pots.length > 0) return 1; }); // ABFC2090 @return 1;
    this.Pots.forEach((p) => { for (let j = 0; j < 2; j++) { if (this.Pots.length > j) return; } }); // ABFC2090 @return;
    outer: for (const p of this.Pots) { continue outer; } // ABFC2099
  }
}

declare const BAD_FREQ: number;

@blueprint({
  path: "/TestMod/Relay/BP_BadDefaults",
  replicates: true,
  alwaysRelevant: true, // ABFC2062 @alwaysRelevant
  netUpdateFrequency: BAD_FREQ, // ABFC2061 @BAD_FREQ
  tickInterval: 0.5, // ABFC2062 @tickInterval
  tickEnabled: false, // ABFC2062 @tickEnabled
})
export class BP_BadDefaults extends FakeWidget {}

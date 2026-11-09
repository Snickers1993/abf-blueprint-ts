// Test API for `*.test.ts` files. abfc compiles these files statically (statements -> bp_game_test steps); nothing here
// runs in Node, so the runtime functions only exist to give a clear message when someone executes a test file.

export type Ctor = abstract new (...a: never[]) => unknown;

export interface Value<T> {
  readonly __value?: T;
}

export interface Assertion {
  /** Marks a pre-existing failure: a failing step becomes warning ABFC6102, a passing one ABFC6103. */
  knownIssue(reason: string): void;
}

export interface Expectation<T> {
  equals(v: T | null | boolean | number | string): Assertion;
  approx(v: number, tolerance?: number): Assertion;
  contains(s: string): Assertion;
  truthy(): Assertion;
  notNone(): Assertion;
  /** The value is a number below `n`. */
  below(n: number): Assertion;
  /** The value is a number above `n`. */
  above(n: number): Assertion;
}

/** What every handle can do, whatever its class. */
export interface AnyHandle {
  /** Teleports the actor to a world location (cm). */
  moveTo(x: number, y: number, z: number): void;
  /** Teleports the actor to where another actor is. */
  moveTo(other: AnyHandle): void;
  /** Turns the actor, and the view of its controller when it has one (a player's camera follows), to `pitch`/`yaw` degrees. */
  aim(pitch: number, yaw: number): void;
}

export interface Handle<T> extends AnyHandle {
  call<K extends keyof T & string>(
    fn: K,
    ...args: T[K] extends (...a: infer A) => any ? A : never
  ): Value<T[K] extends (...a: any) => infer R ? R : never>;
  get<K extends keyof T & string>(prop: K): Value<T[K]>;
  set<K extends keyof T & string>(prop: K, value: T[K]): void;
}

export interface WaitOptions {
  /** Seconds before the wait gives up and the step fails (default 10). */
  timeout?: number;
  /** Seconds between two looks (default 0.25). */
  every?: number;
}

export interface FindOptions {
  /** Seconds to wait for the actor to appear (default 120). */
  timeout?: number;
}

export interface TestOptions {
  /** The map the game opens, e.g. "/Game/Maps/Facility" (default: the backend's empty map, which has no player). */
  map?: string;
  /** Seconds the whole run may take, map loading included (default 180). */
  timeout?: number;
}

export interface TestContext {
  spawn<C extends Ctor>(cls: C): Handle<InstanceType<C>>;
  /** The first actor of this class in the world, waiting until one appears (the player, a director's spawn, a placed actor). */
  find<C extends Ctor>(cls: C, o?: FindOptions): Handle<InstanceType<C>>;
  /** The distance between two actors (cm), read when the step runs. */
  distance(a: AnyHandle, b: AnyHandle): Value<number>;
  /**
   * Looks at `v` (an `h.get(...)`, `h.call(...)`, `t.distance(...)` or `t.python(...)` written inline) again and again until the expectation
   * holds, and fails when it still does not after `timeout` seconds.
   */
  waitUntil<T>(v: Value<T>, o?: WaitOptions): Expectation<T>;
  widget<C extends Ctor>(cls: C): Handle<InstanceType<C>>;
  wait(seconds: number): void;
  python(code: string, o?: { knownIssue?: string }): Value<unknown>;
  expect<T>(v: Value<T>): Expectation<T>;
  /** Prints `v` (read when the step runs) under `label` in the test's output, whether the test passes or fails. */
  note(label: string, v: Value<unknown>): void;
}

export interface TestFn {
  (name: string, body: (t: TestContext) => void | Promise<void>): void;
  (name: string, options: TestOptions, body: (t: TestContext) => void | Promise<void>): void;
  /**
   * A test that needs the live HUD, which hidden runs do not have. It is type-checked and compiled like any test but never
   * run: abfc skips it with warning ABFC6105 and lists `name` and the `checklist` (an array literal of strings) in
   * `.abfc/reports/manual-checks.md` for a manual check in Play In Editor.
   */
  liveHud(name: string, checklist: readonly string[], body: (t: TestContext) => void | Promise<void>): void;
}

function notRun(): never {
  throw new Error("testkit files are compiled by abfc, not run");
}

export const test: TestFn = Object.assign((_name: string, _a: unknown, _b?: unknown): void => notRun(), {
  liveHud: (_name: string, _checklist: readonly string[], _body: (t: TestContext) => void | Promise<void>): void => notRun(),
});

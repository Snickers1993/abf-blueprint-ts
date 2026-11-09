// Ambient API for abfc TypeScript sources. Types only: the emitted JavaScript is empty.
// Branded numbers and strings use "flavoring": literals assign to any flavor, flavors do not mix.

export type int = number & { readonly __bpNumber?: "int" };
export type int64 = number & { readonly __bpNumber?: "int64" };
export type byte = number & { readonly __bpNumber?: "byte" };
/** A float pin also takes a double: the editor converts real to float on the pin, as when wiring it by hand. */
export type float = number & { readonly __bpNumber?: "float" | "double" };
export type double = number & { readonly __bpNumber?: "double" };

export type name = string & { readonly __bpString?: "name" };
/**
 * Localizable text. A template literal where a `text` is expected (`` `Hunger ${hunger}` ``) becomes a Format Text node (where a `string` is expected, or in a `const`, it is converted with To String (Text)): each
 * substitution is an argument named after its identifier or property, and literal `{`, `}` are escaped for you. An object literal
 * where a stub struct is expected (`{ Size: 12 }`) becomes a Make Struct node; spreads and computed names are not supported.
 */
export type text = string & { readonly __bpString?: "text" };

export type TSubclassOf<T> = { readonly __bpClassOf?: T };
export type TSoftObjectPtr<T> = { readonly __bpSoftObjectOf?: T };
export type TSoftClassPtr<T> = { readonly __bpSoftClassOf?: T };

/** A gameplay tag constant, e.g. `ClassManager.EntityDirector.MyDirector` (generated into `.abfc/tags.d.ts` by `abfc generate`). */
export interface GameplayTag<N extends string = string> {
  readonly __gameplayTag: N;
}
declare global {
  /** Filled by the generated `.abfc/tags.d.ts` with one `"<tag>": true` member per known gameplay tag (autocomplete for string tags). */
  interface AbfcKnownGameplayTags {}
}

/** Enum value as its T3D text (for example `"Collapsed"`); `P` is the enum path. */
export type EnumText<P extends string> = string & { readonly __bpEnum?: P };

/** A delegate argument: a reference to an own `@event` method (`this.ScanPlayers`). */
export type DelegateRef = { readonly __bpDelegate?: true } | ((...a: any[]) => void);

export interface SpawnOptions {
  owner?: object | null;
  instigator?: object | null;
  /** Where the actor spawns (a Transform, e.g. `KismetMathLibrary.MakeTransform(loc, rot, scale)`); default: the world origin. */
  transform?: object;
  collisionHandlingOverride?: EnumText<"/Script/Engine.ESpawnActorCollisionHandlingMethod">;
  transformScaleMethod?: EnumText<"/Script/Engine.ESpawnActorScaleMethod">;
}

export interface BlueprintOptions {
  /**
   * Optional override of the asset path, relative to the mod (`"Relays/OldName"`). Without it the path derives from the file
   * location under the source root and the class name.
   */
  path?: string;
  parent?: string;
  replicates?: boolean;
  alwaysRelevant?: boolean;
  onlyRelevantToOwner?: boolean;
  netUpdateFrequency?: number;
  minNetUpdateFrequency?: number;
  tickInterval?: number;
  /** Not supported yet (ABFC2063): writing the saved bStartWithTickEnabled is unverified. */
  tickEnabled?: boolean;
  /** row asset path, verified (Phase 2) @deprecated Use `@director("RowName")`. */
  classManagerRow?: string;
  /** The asset is a Widget Blueprint; the class must extend a UserWidget. The designer layout (WidgetTree) stays hand-made; designer widgets are read-only members of the `_Manual` stub. */
  kind?: "widget";
}

export interface StructOptions {
  /**
   * Optional override of the struct asset path, relative to the mod (`"Structs/S_Entry"`). Without it the path derives from the
   * file location under the source root and the class name. The object path is `<path>.<AssetName>`.
   */
  path?: string;
}

/**
 * Names the class-manager row of a `@blueprint` class (not a widget): the row asset `/<mod>/<classManager.table>/<row>` (default table
 * `DataTables/DT_ClassManager`) references the generated class. The build writes the row when the backend supports it, else it only
 * verifies it. The row name is a string literal made of A-Z, a-z, 0-9 and _.
 *
 * The optional second argument is the gameplay tag the row holds (`ClassManager.EntityDirector.<Row>`): a generated tag constant
 * (`ClassManager.EntityDirector.MyDirector`, declared in `.abfc/tags.d.ts` by `abfc generate`) or a string literal. A tag that is not
 * in the mod's tag list yet is added to `Config/Tags/<mod>Tags.ini` by the build. Without a tag a new row has none and the director
 * never starts (ABFC2079).
 */
export declare function director(row: string, tag?: GameplayTag | keyof AbfcKnownGameplayTags | (string & {})): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext<T>) => void;
export declare function blueprint(o?: BlueprintOptions): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext<T>) => void;
/**
 * A mod-defined struct (UserDefinedStruct) created by abfc. Declare the fields as `Name!: Type;` (no initializer, no methods, no
 * `extends`, no containers). Use the class as a type: an object literal where it is expected becomes a Make Struct node and
 * reading a member of a value of it becomes a Break Struct node. Changing the fields after the struct was created is not supported yet.
 */
export declare function struct(o?: StructOptions): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext<T>) => void;
export declare function event(m: (this: any, ...a: any[]) => void, ctx: ClassMethodDecoratorContext): void;
export declare function override(m: (this: any, ...a: any[]) => void, ctx: ClassMethodDecoratorContext): void;
export declare function createWidget<T>(cls: abstract new (...a: never[]) => T, owningPlayer: object | null): T;
export declare function spawnActor<T>(cls: abstract new (...a: never[]) => T, opts?: SpawnOptions): T;
/**
 * A hard reference to an existing asset (mesh, material, sound, data asset): `asset(StaticMesh, "@mod/Meshes/SM_Crate")` or
 * `asset(SoundBase, "/Game/Audio/S_Beep")`. Only as an argument of a call: it becomes that pin's default object, so the
 * asset cooks with the Blueprint and needs no load node. The path is a string literal; `@mod/` means the mod being built.
 */
/**
 * The world subsystem of class `cls` (Blueprint "Get <Subsystem>", K2Node_GetSubsystem): `getWorldSubsystem(WorldFlagSubsystem)`.
 * A pure node with no exec pins; call the subsystem's own functions on the result (`sub.HasWorldFlag(...)`). The class must be a
 * native WorldSubsystem (a `/Script/...` class with stubs).
 */
export declare function getWorldSubsystem<T>(cls: abstract new (...a: never[]) => T): T;
export declare function asset<T>(cls: abstract new (...a: never[]) => T, path: string): T;
/**
 * Binds `target`'s function or event `fn` to `source`'s event dispatcher (Bind Event to <Dispatcher>): Add Delegate plus
 * Create Event. Both names are string literals; the function's signature must match the dispatcher's. A statement only.
 */
export declare function bindEvent(source: object, dispatcher: string, target: object, fn: string): void;
export declare function nameOf(text: string): name;
export declare function cast<T>(value: object | null | undefined, cls: abstract new (...a: never[]) => T): T | null;
export declare function isValid<T>(value: T | null | undefined): value is T;
/** Integer division (truncates toward zero), Blueprint "Divide_IntInt". */
export declare function idiv(a: int, b: int): int;

// HIR -> IR lowering (design 6): one asset per class, one unit per event, override or function.
import { canonicalJson, sha256 } from "@abfc/ir";
import type { IrAsset, IrComponent, IrModule, IrUnit, IrVariable, Profile } from "@abfc/ir";
import type { HirProgram } from "../hir.js";
import { UnitBuilder } from "./builder.js";

export { formatLiteral } from "./builder.js";
export { assignPositions } from "./layout.js";

export interface LowerOptions {
  /** Lower eligible loops to StandardMacros instances (default true). */
  loopMacros?: boolean;
}

export function lower(h: HirProgram, profile: Profile, opts: LowerOptions = {}): IrModule {
  // Structs first: a Blueprint (or another struct) that uses one needs it to exist.
  const structs: IrAsset[] = h.structs.map((st) => ({
    path: st.path,
    create: { kind: "UserDefinedStruct" as const, parent: "" },
    variables: [],
    units: [],
    structFields: st.fields.map((f) => ({ name: f.memberName, type: f.type, flags: [], origin: f.span })),
  }));
  const classes: IrAsset[] = h.classes.map((cls) => {
    const components: IrComponent[] = cls.fields.filter((f) => f.component !== undefined).map((f) => ({
      name: f.name,
      class: f.component!.class,
      ...(f.component!.attachTo !== undefined ? { attachTo: f.component!.attachTo } : {}),
      props: f.component!.props,
      origin: f.span,
    }));
    const variables: IrVariable[] = cls.fields.filter((f) => f.component === undefined).map((f) => ({ name: f.name, type: f.type, ...(f.default !== undefined ? { default: f.default } : {}), flags: [], origin: f.span }));
    const units: IrUnit[] = [];
    for (const ev of cls.events) {
      const b = new UnitBuilder(profile, h.classMeta, ev);
      b.loopMacros = opts.loopMacros !== false;
      units.push(b.build());
      variables.push(...b.vars);
    }
    // a changed component or interface list changes the class defaults hash, so the asset is planned again (the template skips the key)
    const structure = components.length > 0 || (cls.interfaces?.length ?? 0) > 0
      ? sha256(canonicalJson({ components: components.map(({ origin: _o, ...c }) => c), interfaces: cls.interfaces ?? [] })).slice(0, 32)
      : undefined;
    const classDefaults = Object.keys(cls.defaults).length > 0 || structure !== undefined
      ? { ...cls.defaults, ...(structure !== undefined ? { "abfc:structure": structure } : {}) }
      : undefined;
    return {
      path: cls.path,
      create: { kind: cls.kind === "widget" ? "WidgetBlueprint" : "Blueprint", parent: cls.parent },
      variables,
      units,
      ...(classDefaults !== undefined ? { classDefaults } : {}),
      ...(cls.classManagerRow !== undefined ? { classManagerRow: cls.classManagerRow } : {}),
      ...(cls.director !== undefined ? { director: cls.director } : {}),
      ...(cls.interfaces !== undefined && cls.interfaces.length > 0 ? { interfaces: [...cls.interfaces] } : {}),
      ...(components.length > 0 ? { components } : {}),
    };
  });
  return { irVersion: 1, profile: profile.id, mod: h.mod, assets: [...structs, ...classes], classMeta: h.classMeta };
}

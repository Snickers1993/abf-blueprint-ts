// HIR -> IR lowering (design 6): one asset per class, one unit per event, override or function.
import type { IrAsset, IrModule, IrUnit, IrVariable, Profile } from "@abfc/ir";
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
    const variables: IrVariable[] = cls.fields.map((f) => ({ name: f.name, type: f.type, ...(f.default !== undefined ? { default: f.default } : {}), flags: [], origin: f.span }));
    const units: IrUnit[] = [];
    for (const ev of cls.events) {
      const b = new UnitBuilder(profile, h.classMeta, ev);
      b.loopMacros = opts.loopMacros !== false;
      units.push(b.build());
      variables.push(...b.vars);
    }
    return {
      path: cls.path,
      create: { kind: cls.kind === "widget" ? "WidgetBlueprint" : "Blueprint", parent: cls.parent },
      variables,
      units,
      ...(Object.keys(cls.defaults).length > 0 ? { classDefaults: { ...cls.defaults } } : {}),
      ...(cls.classManagerRow !== undefined ? { classManagerRow: cls.classManagerRow } : {}),
      ...(cls.director !== undefined ? { director: cls.director } : {}),
      ...(cls.interfaces !== undefined && cls.interfaces.length > 0 ? { interfaces: [...cls.interfaces] } : {}),
    };
  });
  return { irVersion: 1, profile: profile.id, mod: h.mod, assets: [...structs, ...classes], classMeta: h.classMeta };
}

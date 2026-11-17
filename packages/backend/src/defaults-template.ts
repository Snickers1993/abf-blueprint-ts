// Class-defaults pass (design 6.2 pass 5): the FIXED Python template that sets class defaults on a Blueprint's CDO.
// Only values that passed the validation below reach the template; no text of the user's program is ever pasted into code.
import { AbfcError } from "@abfc/env";

interface DefaultKind {
  /** `bool` values are `True`/`False`, `float` values are `%f` text. */
  type: "bool" | "float";
  /** `unreal` editor property name (`set_editor_property`), or a CDO method name when `method` is set. */
  python: string;
  method?: boolean;
  /** The property lives in the PrimaryActorTick struct: read the struct, set the field, write it back. */
  tick?: boolean;
}

/** Class default (T3D property name) -> how the template writes it. */
export const DEFAULT_KINDS: Readonly<Record<string, DefaultKind>> = {
  bReplicates: { type: "bool", python: "replicates" },
  bAlwaysRelevant: { type: "bool", python: "always_relevant" },
  bOnlyRelevantToOwner: { type: "bool", python: "only_relevant_to_owner" },
  NetUpdateFrequency: { type: "float", python: "net_update_frequency" },
  MinNetUpdateFrequency: { type: "float", python: "min_net_update_frequency" },
  TickInterval: { type: "float", python: "set_actor_tick_interval", method: true },
  // `set_actor_tick_enabled` on a CDO changes the tick function's state, not the saved flag, so the struct is written back whole;
  // the pass prints ABFC_TICK <value> after it so a build can confirm it held.
  bStartWithTickEnabled: { type: "bool", python: "start_with_tick_enabled", tick: true },
};

/** Own field defaults (`field:<Name>` keys): a JSON value read by the fixed helper below; only validated shapes pass. */
const FIELD_KEY = /^field:([A-Za-z_][A-Za-z0-9_]*)$/;
const OBJECT_PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*\.[A-Za-z0-9_]+$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Class-defaults key holding a hash of the components and interfaces (see the compiler); skipped by the template. */
export const STRUCTURE_KEY = "abfc:structure";

const FIELD_HELPER = [
  "import json",
  "import re",
  // a property is found by its Unreal name first, then by the Python name Unreal derives from it (bHidden -> hidden, RelativeLocation -> relative_location)
  "def _abfc_set(o, n, v):",
  "    try:",
  "        o.set_editor_property(n, v)",
  "    except Exception:",
  "        p = n[1:] if re.match(r'^b[A-Z]', n) else n",
  "        o.set_editor_property(re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', '_', p).lower(), v)",
  "def _abfc_val(v):",
  "    k = v['k']",
  "    if k == 'none':",
  "        return None",
  "    if k in ('bool', 'num', 'str'):",
  "        return v['v']",
  "    if k == 'name':",
  "        return unreal.Name(v['v'])",
  "    if k == 'text':",
  "        return unreal.Text(v['v'])",
  "    if k == 'asset':",
  "        a = unreal.load_asset(v['path'])",
  "        if a is None:",
  "            print('ABFC_FIELD_MISSING ' + v['path'])",
  "        return a",
  "    if k == 'class':",
  "        c = unreal.load_class(None, v['path'])",
  "        if c is None:",
  "            print('ABFC_FIELD_MISSING ' + v['path'])",
  "        return c",
  "    if k == 'struct':",
  "        s = getattr(unreal, v['name'])()",
  "        for f, x in v['fields'].items():",
  "            _abfc_set(s, f, _abfc_val(x))",
  "        return s",
  "    if k == 'array':",
  "        return [_abfc_val(x) for x in v['items']]",
  "    raise ValueError('ABFC field default kind ' + str(k))",
];

/** Throws ABFC2061 unless `v` is a field default value of a known shape. */
function checkField(v: unknown, where: string, depth = 0): void {
  if (depth > 8 || typeof v !== "object" || v === null || Array.isArray(v)) throw bad(`field default ${where} is not a value object`);
  const o = v as Record<string, unknown>;
  switch (o.k) {
    case "none": return;
    case "bool": if (typeof o.v === "boolean") return; break;
    case "num": if (typeof o.v === "number" && Number.isFinite(o.v)) return; break;
    case "str": case "name": case "text": if (typeof o.v === "string") return; break;
    case "asset": case "class": if (typeof o.path === "string" && OBJECT_PATH.test(o.path)) return; break;
    case "struct":
      if (typeof o.name === "string" && IDENT.test(o.name) && typeof o.fields === "object" && o.fields !== null) {
        for (const [f, x] of Object.entries(o.fields as Record<string, unknown>)) {
          if (!IDENT.test(f)) throw bad(`field default ${where}: struct field "${f}" is not a plain name`);
          checkField(x, `${where}.${f}`, depth + 1);
        }
        return;
      }
      break;
    case "array":
      if (Array.isArray(o.items)) {
        o.items.forEach((x, i) => checkField(x, `${where}[${i}]`, depth + 1));
        return;
      }
      break;
  }
  throw bad(`field default ${where} has an unsupported shape`);
}

const CLASS_PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*\.[A-Za-z0-9_]+$/;
const ASSET_PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
const FLOAT_TEXT = /^\d+\.\d+$/;

function bad(message: string): AbfcError {
  return new AbfcError({ severity: "error", code: "ABFC2061", message }, 2);
}

/**
 * The Python code of the class-defaults pass for one Blueprint class. Throws ABFC2061 for a key or value outside the
 * validated map and for a path that is not a plain asset path.
 */
export function renderDefaultsCode(classPath: string, values: Readonly<Record<string, string>>, classManagerRow?: string): string {
  if (!CLASS_PATH.test(classPath)) throw bad(`class path "${classPath}" is not a plain class path`);
  if (classManagerRow !== undefined && !ASSET_PATH.test(classManagerRow)) throw bad(`classManagerRow "${classManagerRow}" is not a plain asset path`);
  const lines: string[] = [
    `cdo = unreal.get_default_object(unreal.load_class(None, ${JSON.stringify(classPath)}))`,
  ];
  const fields: Array<[string, unknown]> = [];
  for (const key of Object.keys(values).sort()) {
    const fm = FIELD_KEY.exec(key);
    if (fm) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(values[key]!);
      } catch {
        throw bad(`field default ${fm[1]} is not JSON`);
      }
      checkField(parsed, fm[1]!);
      fields.push([fm[1]!, parsed]);
      continue;
    }
    // a hash of the asset's components and interfaces: only makes a changed structure re-plan the asset, nothing to write here
    if (key === STRUCTURE_KEY) {
      if (!/^[0-9a-f]{16,64}$/.test(values[key]!)) throw bad(`${STRUCTURE_KEY} must be a hex hash`);
      continue;
    }
    const kind = DEFAULT_KINDS[key];
    const value = values[key]!;
    if (kind === undefined) throw bad(`class default "${key}" is not supported`);
    if (kind.type === "bool" && value !== "True" && value !== "False") throw bad(`class default ${key} must be True or False, got "${value}"`);
    if (kind.type === "float" && !FLOAT_TEXT.test(value)) throw bad(`class default ${key} must be a number written as %f text, got "${value}"`);
    if (kind.tick === true) {
      lines.push(
        `_tick = cdo.get_editor_property("primary_actor_tick")`,
        `_tick.set_editor_property(${JSON.stringify(kind.python)}, ${value})`,
        `cdo.set_editor_property("primary_actor_tick", _tick)`,
        `print("ABFC_TICK " + str(cdo.get_editor_property("primary_actor_tick").get_editor_property(${JSON.stringify(kind.python)})))`,
      );
      continue;
    }
    lines.push(
      kind.method === true
        ? `cdo.${kind.python}(${value})`
        : `cdo.set_editor_property(${JSON.stringify(kind.python)}, ${value})`,
    );
  }
  if (fields.length > 0) {
    // the values travel as one JSON string literal and are rebuilt by the fixed helper: no program text becomes code
    lines.push(...FIELD_HELPER, `for _n, _v in json.loads(${JSON.stringify(JSON.stringify(fields))}):`, "    _abfc_set(cdo, _n, _abfc_val(_v))", `print("ABFC_FIELDS ${fields.length}")`);
  }
  if (classManagerRow !== undefined) {
    const pkg = classPath.slice(0, classPath.indexOf("."));
    lines.push(
      `row_asset = unreal.load_asset(${JSON.stringify(classManagerRow)})`,
      `row_text = str(row_asset.get_editor_property("row")) if row_asset is not None else ""`,
      `if ${JSON.stringify(pkg)} not in row_text:`,
      `    print(${JSON.stringify(`ABFC2070 class manager row ${classManagerRow} does not reference ${pkg}`)})`,
    );
  }
  return lines.join("\n") + "\n";
}

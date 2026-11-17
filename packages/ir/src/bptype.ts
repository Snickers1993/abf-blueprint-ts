// bp_apply type grammar helpers (port of the MCP backend's t3d.parse_type and bpscan._var_type).

export class BpTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BpTypeError";
  }
}

export type BpContainer = "None" | "Array" | "Set" | "Map";
export interface ParsedBpType {
  cat: string;
  sub: string;
  path: string | null;
  container: BpContainer;
  /** Value type of a `map:<K>:<V>` (`cat`/`sub` describe the key); absent for every other type. */
  value?: ParsedBpType;
}

/**
 * Whether two type strings name the same Blueprint type: `real` and `double` are one type (an exported variable reads back
 * as `real`), and case is ignored. A string that does not parse is compared as text.
 */
export function sameBpType(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  let pa: ParsedBpType, pb: ParsedBpType;
  try {
    pa = parseBpType(a);
    pb = parseBpType(b);
  } catch {
    return false;
  }
  const eq = (x: ParsedBpType | undefined, y: ParsedBpType | undefined): boolean =>
    x === undefined || y === undefined
      ? x === y
      : x.cat === y.cat && x.sub === y.sub && x.container === y.container && (x.path ?? "").toLowerCase() === (y.path ?? "").toLowerCase() && eq(x.value, y.value);
  return eq(pa, pb);
}

/** Key types of maps and element types of sets (a subset of what the backend grammar accepts). */
const KEY_TYPES = new Set(["int", "int64", "byte", "name", "string"]);

const SIMPLE: Record<string, [string, string]> = {
  exec: ["exec", ""], int: ["int", ""], int64: ["int64", ""], bool: ["bool", ""], byte: ["byte", ""],
  name: ["name", ""], string: ["string", ""], text: ["text", ""],
  real: ["real", "double"], double: ["real", "double"], float: ["real", "float"],
};
const OBJ_KINDS: Record<string, string> = {
  object: "object", class: "class", softobject: "softobject", softclass: "softclass",
  interface: "interface", struct: "struct", enum: "byte",
};

export function parseBpType(t: string): ParsedBpType {
  if (typeof t !== "string" || t.trim() === "") throw new BpTypeError(`type must be a non-empty string, got ${JSON.stringify(t)}`);
  t = t.trim();
  if (t.startsWith("array:")) {
    const inner = parseBpType(t.slice(6));
    if (inner.container !== "None") throw new BpTypeError(`nested containers are not supported: ${t}`);
    return { ...inner, container: "Array" };
  }
  const colon = t.indexOf(":");
  const head = colon < 0 ? t : t.slice(0, colon);
  if (head === "map") {
    const rest = t.slice(4);
    const sep = rest.indexOf(":");
    const key = sep < 0 ? rest : rest.slice(0, sep);
    if (sep < 0 || !KEY_TYPES.has(key)) {
      throw new BpTypeError(`map types are map:<key>:<value> with a key type of int int64 byte name string: ${t}`);
    }
    const value = parseBpType(rest.slice(sep + 1));
    if (value.container !== "None") throw new BpTypeError(`nested containers are not supported: ${t}`);
    if (value.cat === "exec") throw new BpTypeError(`a map value cannot be exec: ${t}`);
    const k = SIMPLE[key] as [string, string];
    return { cat: k[0], sub: k[1], path: null, container: "Map", value };
  }
  if (head === "set") {
    const elem = t.slice(4);
    if (!KEY_TYPES.has(elem)) {
      throw new BpTypeError(`set types are set:<type> with an element type of int int64 byte name string: ${t}`);
    }
    const k = SIMPLE[elem] as [string, string];
    return { cat: k[0], sub: k[1], path: null, container: "Set" };
  }
  const simple = Object.hasOwn(SIMPLE, t) ? SIMPLE[t] : undefined;
  if (simple) return { cat: simple[0], sub: simple[1], path: null, container: "None" };
  const objCat = Object.hasOwn(OBJ_KINDS, head) ? OBJ_KINDS[head] : undefined;
  if (objCat !== undefined && colon >= 0) {
    const path = t.slice(colon + 1).trim();
    if (path === "") throw new BpTypeError(`type "${head}" needs a path (a struct with no type crashes the import)`);
    return { cat: objCat, sub: "", path, container: "None" };
  }
  if (objCat !== undefined) throw new BpTypeError(`type "${head}" needs a path, e.g. ${head}:/Script/Engine.Actor`);
  throw new BpTypeError(
    `unknown type ${JSON.stringify(t)} (exec int int64 bool byte name string text real double float ` +
    "object:<path> class:<path> softobject:<path> softclass:<path> interface:<path> struct:<path> enum:<path> array:<type> map:<key>:<type> set:<type>)",
  );
}

/** Object text of a pin's `PinSubCategoryObject`, e.g. `/Script/CoreUObject.Class'/Script/Engine.Actor'`. */
export function pinObjectText(kind: string, path: string, classMeta: Record<string, string>): string {
  const ref = (meta: string): string => `${meta}'${path}'`;
  const script = path.startsWith("/Script/");
  if (kind === "struct") return ref(script ? "/Script/CoreUObject.ScriptStruct" : "/Script/Engine.UserDefinedStruct");
  if (kind === "enum") return ref(script ? "/Script/CoreUObject.Enum" : "/Script/Engine.UserDefinedEnum");
  if (script) return ref("/Script/CoreUObject.Class");
  return ref(classMeta[path] ?? "/Script/Engine.BlueprintGeneratedClass");
}

const PATH_CATEGORIES = new Set(["object", "class", "softobject", "softclass", "interface", "struct"]);

/** Grammar string for an exported pin or variable type (inverse of `parseBpType` for the supported types). */
export function bpTypeFromPin(p: {
  category: string;
  subCategory: string;
  subCategoryObject: string | null;
  container: string;
  /** Value type of a map pin or variable (`PinValueType`); `category` is then the key type. */
  valueType?: { category: string; subCategory: string; subCategoryObject: string | null } | null;
}): string {
  const path = p.subCategoryObject;
  let inner: string;
  switch (p.category) {
    case "bool": case "int": case "int64": case "name": case "string": case "text":
      inner = p.category;
      break;
    case "real":
      inner = p.subCategory === "float" ? "float" : "real";
      break;
    case "byte":
      inner = path ? `enum:${path}` : "byte";
      break;
    default:
      if (!PATH_CATEGORIES.has(p.category)) throw new BpTypeError(`pin category "${p.category}" has no bp_apply type`);
      if (!path) throw new BpTypeError(`pin category "${p.category}" has no object path`);
      inner = `${p.category}:${path}`;
  }
  if (p.container === "None" || p.container === "") return inner;
  if (p.container === "Array") return `array:${inner}`;
  if (p.container === "Set" || p.container === "Map") {
    if (!KEY_TYPES.has(inner)) throw new BpTypeError(`${p.container.toLowerCase()} key/element type "${inner}" is not supported`);
    if (p.container === "Set") return `set:${inner}`;
    if (!p.valueType) throw new BpTypeError("map pin has no value type");
    const v = bpTypeFromPin({ ...p.valueType, container: "None", valueType: null });
    return `map:${inner}:${v}`;
  }
  throw new BpTypeError(`unknown container "${p.container}"`);
}

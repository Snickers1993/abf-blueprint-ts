import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// docs/errors.md has one `### ABFCnnnn` section for every error code in the sources, and no section for a code that is gone.

/** Codes whose section is kept on purpose although no source uses them (the section says "retired"). */
// codes whose section stays in docs/errors.md (marked Retired) so an old message can still be looked up
const RETIRED: readonly string[] = ["2063"];

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "packages")) && existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("repository root (a folder with packages/ and package.json) not found above " + process.cwd());
    dir = up;
  }
}

function sourceFiles(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function sourceCodes(root: string): Set<string> {
  const codes = new Set<string>();
  const files: string[] = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const src = join(root, "packages", pkg, "src");
    if (existsSync(src)) sourceFiles(src, files);
  }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/ABFC(\d{4})/g)) codes.add(m[1]!);
    for (const m of text.matchAll(/\b(?:envError|envWarning)\(\s*(\d{4})\b/g)) codes.add(m[1]!);
  }
  return codes;
}

function docHeadings(root: string): string[] {
  const text = readFileSync(join(root, "docs", "errors.md"), "utf8");
  return [...text.matchAll(/^### ABFC(\d{4})\r?$/gm)].map((m) => m[1]!);
}

test("every error code in the sources has a section in docs/errors.md", () => {
  const root = repoRoot();
  const docs = new Set(docHeadings(root));
  const missing = [...sourceCodes(root)].filter((c) => !docs.has(c)).sort();
  assert.deepEqual(missing, [], `codes without a "### ABFCnnnn" section in docs/errors.md: ${missing.join(", ")}`);
});

test("every section of docs/errors.md is a code in the sources (or on the RETIRED list)", () => {
  const root = repoRoot();
  const source = sourceCodes(root);
  const extra = docHeadings(root).filter((c) => !source.has(c) && !RETIRED.includes(c));
  assert.deepEqual(extra, [], `sections for codes that no source uses: ${extra.join(", ")}`);
});

test("the sections of docs/errors.md are unique and sorted", () => {
  const headings = docHeadings(repoRoot());
  assert.ok(headings.length > 0, "no sections found");
  assert.deepEqual(headings, [...new Set(headings)], "duplicate section");
  assert.deepEqual(headings, [...headings].sort(), "sections are not sorted by code");
});

test("the codes other docs and the language server link to have a section", () => {
  const root = repoRoot();
  const docs = new Set(docHeadings(root));
  const linked = new Set<string>();
  for (const name of ["install", "first-mod", "cli", "config", "backend", "language-service", "troubleshooting", "releasing", "lint-rules"]) {
    const file = join(root, "docs", `${name}.md`);
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/errors\.md#abfc(\d{4})/g)) linked.add(m[1]!);
  }
  const missing = [...linked].filter((c) => !docs.has(c)).sort();
  assert.deepEqual(missing, [], `links to errors.md anchors without a section: ${missing.join(", ")}`);
});

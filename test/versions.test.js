import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const files = [
  ...readdirSync(new URL("src/", ROOT)).filter((name) => name.endsWith(".js")).map((name) => `src/${name}`),
  ...readdirSync(ROOT).filter((name) => name.endsWith(".html")),
];

// Static `import ... from "./x.js"`, side-effect `import "./x.js"`, dynamic `import("./x.js")`
// and `<script src="./src/x.js">` references, each captured as a path plus an optional query.
const REFERENCE = /(?:\bfrom\s*|\bimport\s*\(?\s*|<script\b[^>]*\bsrc\s*=\s*)["'](\.{1,2}\/[^"'?#]+)(\?[^"'#]*)?["']/g;

function collect() {
  const references = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, ROOT), "utf8");
    for (const match of text.matchAll(REFERENCE)) {
      references.push({ file, path: match[1], query: match[2] ?? "" });
    }
  }
  return references;
}

test("the scan finds the module graph", () => {
  const references = collect();
  assert.ok(files.includes("src/page-status.js") && files.includes("rank-history.html"));
  assert.ok(references.length >= 20, `only ${references.length} references found`);
  assert.ok(references.some((ref) => ref.file === "src/rank-history.js" && ref.path === "./page-status.js"));
  assert.ok(references.some((ref) => ref.file === "playstyle.html" && ref.path === "./src/playstyle.js"));
});

test("every relative module import carries a ?v= query", () => {
  for (const ref of collect()) {
    assert.match(ref.query, /^\?v=[\w.-]+$/, `${ref.file} imports ${ref.path} without a ?v= query`);
  }
});

test("each module is imported under exactly one version across all files", () => {
  const versions = new Map();
  for (const ref of collect()) {
    const module = ref.path.replace(/^(\.\.?\/)+(src\/)?/, "");
    if (!versions.has(module)) versions.set(module, new Map());
    const byVersion = versions.get(module);
    byVersion.set(ref.query, [...(byVersion.get(ref.query) ?? []), ref.file]);
  }
  for (const [module, byVersion] of versions) {
    assert.equal(byVersion.size, 1, `${module} is imported under several versions: ${JSON.stringify([...byVersion])}`);
  }
});

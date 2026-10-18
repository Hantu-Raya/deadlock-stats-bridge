// Regenerates assets/ranks/tierNN.webp: the 11 rank tier icons as 64 px wide lossless WebP.
// The CDN only serves 50-90 KB originals, but the chart draws them at 30 px or less.
// Usage: node tools/make-rank-thumbnails.mjs
// Resizing runs through `npx sharp-cli`, which lives in the npx cache: no dependency, no node_modules here.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RANKS_URL = "https://api.deadlock-api.com/v1/assets/ranks";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "ranks");
const TIERS = 11;
const WIDTH = 64;

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const listing = await (await fetch(RANKS_URL)).json();
if (!Array.isArray(listing)) throw new Error("rank listing is not an array");

const work = mkdtempSync(join(tmpdir(), "rank-icons-"));
try {
  const inputs = [];
  for (let tier = 1; tier <= TIERS; tier += 1) {
    const url = listing.find((entry) => entry?.tier === tier)?.images?.large_webp;
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error(`tier ${tier} has no large_webp image`);
    const file = join(work, `tier${String(tier).padStart(2, "0")}.webp`);
    writeFileSync(file, await download(url));
    inputs.push(file);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  // `-o <dir>` keeps each input's file name; resize with only a width keeps the aspect ratio.
  const args = ["--yes", "sharp-cli", "-i", ...inputs, "-o", OUT_DIR, "-f", "webp", "--lossless", "--effort", "6", "resize", String(WIDTH)];
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync(`npx ${args.map((arg) => `"${arg}"`).join(" ")}`, { shell: true, stdio: "inherit" })
    : spawnSync("npx", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`sharp-cli failed (${result.status ?? result.error})`);
  for (const file of inputs) {
    const name = file.slice(work.length + 1);
    console.log(`${name} ${statSync(join(OUT_DIR, name)).size} bytes`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

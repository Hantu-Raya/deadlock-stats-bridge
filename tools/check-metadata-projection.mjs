#!/usr/bin/env node
// Live parity check for the projected /v1/matches/metadata query.
//
//   node tools/check-metadata-projection.mjs [accountId=487348881] [limit=150] [--save=dir]
//
// For ranked and unranked it downloads the legacy (include_player_final_stats) response
// and the projected response built by src/api.js, compares every metric of
// aggregatePlayerPrefixes for each prefix, and checks the projected wire bytes are
// at most 70% of the legacy bytes. Exit code 1 on any difference. Uses 4 API requests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetadataUrl, normalizeMetadataProjection } from "../src/api.js";
import { aggregatePlayerPrefixes } from "../src/metrics.js";

const MAX_RATIO = 0.7;
const PREFIXES = [25, 50, 100, 150];
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const accountId = Number(positional[0] ?? 487348881);
const limit = Number(positional[1] ?? 150);
const saveArg = process.argv.find((arg) => arg.startsWith("--save="));
const saveDir = saveArg ? saveArg.slice("--save=".length) : null;
const MODES = [["ranked", "ranked"], ["standard", "unranked"]];

export function legacyMetadataUrl(id, count, apiMode) {
  const url = new URL("https://api.deadlock-api.com/v1/matches/metadata");
  const params = url.searchParams;
  params.set("include_info", "false");
  params.set("extra_match_columns", "duration_s");
  params.set("include_player_kda", "true");
  params.set("include_player_final_stats", "true");
  params.set("match_mode", apiMode);
  params.set("account_ids", String(id));
  params.set("extra_player_columns", "last_hits,denies,mvp_rank");
  params.set("order_by", "start_time");
  params.set("order_direction", "desc");
  params.set("limit", String(count));
  params.set("format", "json");
  return url.toString();
}

const workDir = mkdtempSync(join(tmpdir(), "metadata-projection-"));
function download(url, name) {
  const file = join(workDir, `${name}.json`);
  const bytes = Number(execFileSync("curl", ["-s", "--compressed", "-f", "-o", file, "-w", "%{size_download}", url], { encoding: "utf8" }));
  return { bytes, data: JSON.parse(readFileSync(file, "utf8")) };
}

function flatten(prefixes) {
  const out = {};
  for (const [key, sample] of Object.entries(prefixes.samples)) {
    out[`${key}.sampleSize`] = sample.sampleSize;
    out[`${key}.totalDurationSeconds`] = sample.totalDurationSeconds;
    for (const metric of sample.metrics) {
      out[`${key}.${metric.id}`] = [metric.value, metric.displayValue];
    }
    for (const [id, value] of Object.entries(sample.supplemental)) {
      out[`${key}.supplemental.${id}`] = [value.value, value.displayValue];
    }
  }
  return out;
}

export function diffAggregates(full, projected) {
  const left = flatten(full);
  const right = flatten(projected);
  const diffs = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) diffs.push({ key, full: left[key], projected: right[key] });
  }
  return diffs;
}

function matchIds(data) {
  return data.map((match) => match.match_id).join(",");
}

let failed = false;
try {
  for (const [mode, apiMode] of MODES) {
    let full;
    let projected;
    // A match finishing between the two downloads shifts the window; retry a few times.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      full = download(legacyMetadataUrl(accountId, limit, apiMode), `full-${mode}`);
      projected = download(buildMetadataUrl(accountId, limit, mode), `projected-${mode}`);
      if (matchIds(full.data) === matchIds(projected.data)) break;
      console.log(`${mode}: match window moved between downloads, retrying (${attempt})`);
    }
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      writeFileSync(join(saveDir, `metadata-full-${limit}-${mode}.json`), JSON.stringify(full.data));
      writeFileSync(join(saveDir, `metadata-projected-${limit}-${mode}.json`), JSON.stringify(projected.data));
    }
    normalizeMetadataProjection(projected.data);
    const fullAgg = aggregatePlayerPrefixes({ accountId, metadata: full.data, limits: PREFIXES });
    const projAgg = aggregatePlayerPrefixes({ accountId, metadata: projected.data, limits: PREFIXES });
    const diffs = diffAggregates(fullAgg, projAgg);
    const ratio = projected.bytes / full.bytes;
    const compared = Object.keys(flatten(fullAgg)).length;
    const ok = diffs.length === 0 && ratio <= MAX_RATIO && matchIds(full.data) === matchIds(projected.data);
    if (!ok) failed = true;
    console.log(`${mode}: matches ${full.data.length}/${projected.data.length}, wire ${full.bytes} -> ${projected.bytes} B (${(ratio * 100).toFixed(1)}%), ${compared} values compared, ${diffs.length} differ -> ${ok ? "PASS" : "FAIL"}`);
    for (const diff of diffs.slice(0, 20)) console.log(`  ${diff.key}: full=${JSON.stringify(diff.full)} projected=${JSON.stringify(diff.projected)}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

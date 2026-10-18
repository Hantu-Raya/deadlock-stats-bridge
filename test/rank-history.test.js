import test from "node:test";
import assert from "node:assert/strict";

import {
  RANK_TITLE_PREFIX,
  buildChartSvg,
  groupPoints,
  monotonePath,
  normalizeHistory,
  normalizeRanks,
  parseRankQuery,
  runRankHistory,
} from "../src/rank-history.js";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  key(index) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

const RANK_ASSETS = Array.from({ length: 12 }, (_, tier) => ({
  tier,
  name: ["Obscurus", "Initiate", "Seeker", "Acolyte", "Sentinel", "Mystic", "Ritualist", "Emissary", "Oracle", "Phantom", "Ascendant", "Eternus"][tier],
  color: "#DDA326",
  images: { large_webp: `https://assets-bucket.deadlock-api.com/assets-api-res/images/ranks/rank${String(tier).padStart(2, "0")}_lg.webp` },
}));

function match(id, time, badge, mode = 4) {
  return { match_id: id, start_time: time, match_mode: mode, ranked_display_badge: badge, ranked_delta: 100 };
}

function query(overrides = {}) {
  return `?${new URLSearchParams({ protocol: "1", request: "q1", account_id: "487348881", group: "5", ...overrides })}`;
}

function jsonResponse(data, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(Object.entries({ "content-type": "application/json", ...headers })),
    text: async () => JSON.stringify(data),
  };
}

function page({ fetchImpl, search = query(), storage = new MemoryStorage(), now = () => 1_800_000_000_000 } = {}) {
  const documentRef = { title: "", body: { innerHTML: "" } };
  const locationRef = { search, hash: "" };
  const size = { width: 1000, height: 140 };
  const resizeTarget = new EventTarget();
  return {
    documentRef, locationRef, storage, size,
    resize(width, height) { Object.assign(size, { width, height }); resizeTarget.dispatchEvent(new Event("resize")); },
    run: (extra = {}) => runRankHistory({ documentRef, locationRef, fetchImpl, storage, now, viewport: () => ({ ...size }), resizeTarget, ...extra }),
    payload() {
      assert.ok(documentRef.title.startsWith(RANK_TITLE_PREFIX), documentRef.title);
      assert.equal(decodeURIComponent(locationRef.hash), documentRef.title, "fragment mirrors title");
      return JSON.parse(documentRef.title.slice(RANK_TITLE_PREFIX.length));
    },
  };
}

test("query parsing accepts only the four group sizes and canonical accounts", () => {
  assert.deepEqual(parseRankQuery(query()), { request: "q1", account: 487348881, group: 5 });
  for (const group of ["1", "10", "25"]) assert.equal(parseRankQuery(query({ group })).group, Number(group));
  for (const bad of [{ group: "3" }, { group: "" }, { account_id: "0" }, { account_id: "012" }, { account_id: "4294967296" }, { request: "a b" }, { protocol: "2" }]) {
    assert.equal(parseRankQuery(query(bad)), null, JSON.stringify(bad));
  }
});

test("history keeps ranked badged matches once, oldest first, as tier ordinals", () => {
  const points = normalizeHistory([
    match(3, 300, 115),
    match(1, 100, 96),
    match(2, 200, 0),
    match(4, 400, 121, 1),
    match(5, 500, 117),
    match(6, 600, 50),
    match(9, 900, 125),
    match(3, 300, 115),
    match(7, 700, 120),
    { match_id: "8", start_time: 800, match_mode: 4, ranked_display_badge: 113 },
  ]);
  assert.deepEqual(points, [[100, 54], [300, 65]], "badge 96 = Phantom 6 -> 54; 115 = Eternus 5 -> 65; invalid subranks, unranked and malformed rows are dropped");
  assert.throws(() => normalizeHistory({ not: "an array" }), /invalid/);
});

test("rank assets require tiers 1-11 with names and https images", () => {
  const ranks = normalizeRanks(RANK_ASSETS);
  assert.equal(ranks.length, 11);
  assert.deepEqual(ranks[8], { tier: 9, name: "Phantom", color: "#DDA326", icon: RANK_ASSETS[9].images.large_webp });
  assert.equal(normalizeRanks([{ tier: 9, name: "<b>", color: "red;}", images: { large_webp: "javascript:alert(1)" } }])[0].icon, "", "unsafe icon and color are dropped");
  assert.equal(normalizeRanks([{ tier: 9, name: "<b>", color: "red;}", images: {} }])[0].color, "");
});

test("grouping averages ordinals in non-overlapping buckets and keeps the partial tail", () => {
  const points = [[1, 10], [2, 12], [3, 14], [4, 16], [5, 20]];
  assert.deepEqual(groupPoints(points, 1), points);
  assert.deepEqual(groupPoints(points, 2), [[2, 11], [4, 15], [5, 20]]);
  assert.deepEqual(groupPoints(points, 25), [[5, 14.4]]);
  assert.deepEqual(groupPoints([], 5), []);
});

test("monotone path never overshoots between neighbouring points", () => {
  const xs = [0, 10, 20, 30, 40];
  const ys = [50, 50, 10, 10, 30];
  const path = monotonePath(xs, ys);
  assert.match(path, /^M0,50 C/);
  const controls = [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(controls.every((y) => y >= 10 - 1e-9 && y <= 50 + 1e-9), "control points stay inside the data range");
});

test("svg escapes API text, labels each tier with its icon and keeps one marker per point", () => {
  const ranks = normalizeRanks(RANK_ASSETS.map((rank) => (rank.tier === 9 ? { ...rank, name: "<script>x</script>" } : rank)));
  const svg = buildChartSvg([[1_700_000_000, 50], [1_700_100_000, 54], [1_700_200_000, 56]], ranks, { width: 1000, height: 140 });
  assert.ok(!svg.includes("<script>"), "tier names are escaped");
  assert.equal((svg.match(/<circle [^>]*data-point/g) || []).length, 3, "short histories mark every point");
  assert.match(svg, /rank09_lg\.webp/);
  assert.match(svg, /rank10_lg\.webp/);
});

// Failure modes: the callout shows a group average instead of the latest real rank; long histories bury the
// line under hundreds of dots; a missing icon or name breaks the callout.
test("the current-rank callout names the latest match, and long histories mark only the latest point", () => {
  const ranks = normalizeRanks(RANK_ASSETS);
  const svg = buildChartSvg([[1, 50], [2, 53.4]], ranks, { width: 1000, height: 140, current: 56 });
  assert.match(svg, /data-current[^>]*>Ascendant 2</, "ordinal 56 is Ascendant 2, not the averaged 53.4 (Phantom 5)");
  const fallback = buildChartSvg([[1, 50], [2, 54]], ranks, { width: 1000, height: 140 });
  assert.match(fallback, /data-current[^>]*>Phantom 6</, "without a raw rank the callout uses the last point");
  const long = Array.from({ length: 120 }, (_, index) => [index, 50 + (index % 6)]);
  const dense = buildChartSvg(long, ranks, { width: 1000, height: 140 });
  assert.equal((dense.match(/<circle [^>]*data-point/g) || []).length, 1, "only the latest point is marked");
  const bare = buildChartSvg([[1, 50]], normalizeRanks([]), { width: 1000, height: 140, current: 50 });
  assert.match(bare, /data-current[^>]*>Rank 9 2</, "missing assets fall back to a tier number");
});

test("run fetches history and ranks once, renders, and reuses the cache for another group", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("/assets/ranks")) return jsonResponse(RANK_ASSETS);
    return jsonResponse([match(1, 1_700_000_000, 96), match(2, 1_700_100_000, 101), match(3, 1_700_200_000, 104)]);
  };
  const first = page({ fetchImpl });
  assert.deepEqual(await first.run(), { ok: true, points: 1 });
  assert.deepEqual(first.payload(), { v: 1, request: "q1", kind: "ready", points: 1 });
  assert.match(first.documentRef.body.innerHTML, /<svg /);
  assert.deepEqual(urls, [
    "https://api.deadlock-api.com/v1/assets/ranks",
    "https://api.deadlock-api.com/v1/players/487348881/match-history",
  ]);
  const second = page({ fetchImpl, storage: first.storage, search: query({ group: "1", request: "q2" }) });
  assert.deepEqual(await second.run(), { ok: true, points: 3 });
  assert.equal(urls.length, 2, "a group change inside the freshness window does not refetch");
  const later = page({ fetchImpl, storage: first.storage, now: () => 1_800_000_000_000 + 6 * 60 * 1000 });
  await later.run();
  assert.equal(urls.length, 3, "history older than five minutes is refetched; rank assets stay cached");
});

test("empty history and failures publish typed titles and visible text", async () => {
  const empty = page({ fetchImpl: async (url) => jsonResponse(url.includes("ranks") ? RANK_ASSETS : [match(1, 1, 0)]) });
  assert.deepEqual(await empty.run(), { ok: true, points: 0 });
  assert.deepEqual(empty.payload(), { v: 1, request: "q1", kind: "empty", points: 0 });
  assert.match(empty.documentRef.body.innerHTML, /No ranked matches/);
  for (const [fetchImpl, code] of [
    [async () => { throw new TypeError("offline"); }, "network_error"],
    [async () => jsonResponse({}, 429, { "retry-after": "30" }), "rate_limit"],
    [async () => jsonResponse({}, 500), "upstream_error"],
    [async (url) => jsonResponse(url.includes("ranks") ? RANK_ASSETS : { bad: true }), "invalid_payload"],
  ]) {
    const failed = page({ fetchImpl });
    assert.equal((await failed.run()).ok, false);
    assert.deepEqual(failed.payload(), { v: 1, request: "q1", kind: "error", code });
    assert.match(failed.documentRef.body.innerHTML, /Rank history unavailable/);
  }
  const invalid = page({ fetchImpl: async () => { throw new Error("must not fetch"); }, search: query({ group: "7" }) });
  await invalid.run();
  assert.deepEqual(invalid.payload(), { v: 1, request: "", kind: "error", code: "invalid_query" });
});

test("aborted page publishes nothing", async () => {
  const controller = new AbortController();
  const aborted = page({ fetchImpl: async () => { controller.abort(); const error = new Error("aborted"); error.name = "AbortError"; throw error; } });
  await aborted.run({ signal: controller.signal });
  assert.equal(aborted.documentRef.title, "");
});

// Failure modes: Panorama un-collapses the host in the same frame it loads the page, so the browser can
// start at 0x0 or a stale size; a cached page then renders before layout and stays mis-sized forever.
test("the chart redraws at the browser's current size and survives a zero-size start", async () => {
  const fetchImpl = async (url) => jsonResponse(url.includes("/assets/ranks") ? RANK_ASSETS : [match(1, 1_700_000_000, 96), match(2, 1_700_100_000, 101)]);
  const chart = page({ fetchImpl });
  chart.size.width = 0; chart.size.height = 0;
  await chart.run();
  assert.match(chart.documentRef.body.innerHTML, /<svg [^>]*width="1000" height="140"/, "a zero-size browser draws at the fallback size");
  const title = chart.documentRef.title;
  chart.resize(720, 166);
  assert.match(chart.documentRef.body.innerHTML, /<svg [^>]*width="720" height="166"/, "a resize redraws at the laid-out size");
  assert.equal(chart.documentRef.title, title, "a redraw does not republish the status");
  const failed = page({ fetchImpl: async () => jsonResponse({}, 500) });
  await failed.run();
  failed.resize(720, 166);
  assert.match(failed.documentRef.body.innerHTML, /Rank history unavailable/, "a resize never replaces the error text");
});

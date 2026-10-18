import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RANK_TITLE_PREFIX,
  buildChartSvg,
  groupPoints,
  monotonePath,
  normalizeHistory,
  normalizeMmrHistory,
  normalizeRanks,
  parseRankQuery,
  runRankHistory,
} from "../src/rank-history.js";

const PARITY = JSON.parse(readFileSync(new URL("./fixtures/rank-history-parity.json", import.meta.url), "utf8"));
const MMR_DOWN_KEY = "dlrh:mmr-down:v1";
const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

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

function mmrRow(id, time, rank) {
  return { account_id: 487348881, match_id: id, start_time: time, player_score: 1, rank, division: Math.floor(rank / 10), division_tier: rank % 10 };
}

// Routes the three endpoints; `mmr` / `mh` are a body or a function returning a response, and `urls` records every call.
function router({ mmr, mh, urls = [] }) {
  const answer = (value) => (typeof value === "function" ? value() : jsonResponse(value));
  return async (url) => {
    urls.push(url);
    if (url.includes("/assets/ranks")) return jsonResponse(RANK_ASSETS);
    if (url.includes("/mmr-history")) return answer(mmr);
    if (url.includes("/match-history")) return answer(mh);
    throw new Error(`unexpected url ${url}`);
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

test("rank assets require tiers 1-11 with names, and icons come from the local thumbnails", () => {
  const ranks = normalizeRanks(RANK_ASSETS);
  assert.equal(ranks.length, 11);
  assert.deepEqual(ranks[8], { tier: 9, name: "Phantom", color: "#DDA326", icon: "./assets/ranks/tier09.webp" });
  assert.deepEqual(ranks.map((rank) => rank.icon), Array.from({ length: 11 }, (_, index) => `./assets/ranks/tier${String(index + 1).padStart(2, "0")}.webp`));
  assert.equal(normalizeRanks([{ tier: 9, name: "<b>", color: "red;}", images: { large_webp: "javascript:alert(1)" } }])[0].icon, "./assets/ranks/tier09.webp", "API image URLs are never used");
  assert.equal(normalizeRanks([{ tier: 9, name: "<b>", color: "red;}", images: {} }])[0].color, "");
  assert.equal(normalizeRanks([{ tier: 0, name: "Obscurus" }, { tier: 12, name: "Eternus" }]).length, 0, "tiers without a local file are dropped");
});

test("mmr history keeps each match once, oldest first, as tier ordinals", () => {
  const points = normalizeMmrHistory([
    mmrRow(3, 300, 115),
    mmrRow(1, 100, 96),
    mmrRow(3, 300, 115),
    mmrRow(2, 200, 0),
    mmrRow(4, 400, 121),
    { ...mmrRow(5, 500, 117), match_id: "5" },
    { ...mmrRow(6, 600, 117), start_time: 0 },
    null,
    mmrRow(7, 100, 101),
  ]);
  assert.deepEqual(points, [[100, 54], [100, 55], [300, 65]], "96 = Phantom 6 -> 54; 101 = Ascendant 1 -> 55 (same time, later match id); duplicates and invalid rows are dropped");
  assert.deepEqual(normalizeMmrHistory([]), []);
  assert.deepEqual(normalizeMmrHistory([{ match_id: 1, start_time: 5 }]), [], "rows without a rank are unusable, not an error");
  assert.throws(() => normalizeMmrHistory({ not: "an array" }), /invalid/);
});

// Failure mode: the cheap endpoint drifts from the match list and the chart silently changes shape.
test("mmr-history yields exactly the points match-history does for the recorded accounts", () => {
  for (const [account, { mmrHistory, matchHistory }] of Object.entries(PARITY)) {
    const fromMatches = normalizeHistory(matchHistory);
    assert.ok(fromMatches.length > 100, `${account} has a real history`);
    assert.ok(mmrHistory.length > new Set(mmrHistory.map((row) => row.match_id)).size, `${account} contains duplicate rows`);
    assert.deepEqual(normalizeMmrHistory(mmrHistory), fromMatches, account);
  }
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
  assert.match(svg, /href="\.\/assets\/ranks\/tier09\.webp"/);
  assert.match(svg, /href="\.\/assets\/ranks\/tier10\.webp"/);
});

// Failure mode: a tier icon fetched from the CDN costs 50-90 KB each; a stale cache or API change must not bring it back.
test("the chart SVG references only local rank icons", () => {
  const points = [[1, 40], [2, 50], [3, 66]];
  const hrefs = (svg) => [...svg.matchAll(/href="([^"]*)"/g)].map((found) => found[1]);
  const fromApi = hrefs(buildChartSvg(points, normalizeRanks(RANK_ASSETS), { width: 1000, height: 140 }));
  assert.ok(fromApi.length >= 3, "icons are drawn");
  assert.ok(fromApi.every((href) => /^\.\/assets\/ranks\/tier(0[1-9]|1[01])\.webp$/.test(href)), fromApi.join());
  const stale = normalizeRanks(RANK_ASSETS).map((rank) => ({ ...rank, icon: RANK_ASSETS[rank.tier].images.large_webp }));
  assert.deepEqual(hrefs(buildChartSvg(points, stale, { width: 1000, height: 140 })), [], "a CDN icon in a rank entry is not rendered");
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
  const fetchImpl = router({
    urls,
    mmr: [mmrRow(1, 1_700_000_000, 96), mmrRow(2, 1_700_100_000, 101), mmrRow(3, 1_700_200_000, 104)],
    mh: () => { throw new Error("match-history is only a fallback"); },
  });
  const first = page({ fetchImpl });
  assert.deepEqual(await first.run(), { ok: true, points: 1 });
  assert.deepEqual(first.payload(), { v: 1, request: "q1", kind: "ready", points: 1 });
  assert.match(first.documentRef.body.innerHTML, /<svg /);
  assert.deepEqual(urls, [
    "https://api.deadlock-api.com/v1/assets/ranks",
    "https://api.deadlock-api.com/v1/players/487348881/mmr-history",
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

// Failure modes: the plot loses its 12% / 15% width insets at another size;
// an opaque surface rect survives and brightens the whole card under Panorama's screen blend.
test("the plot spans the shared 12% / 15% width insets and paints no opaque background", () => {
  const ranks = normalizeRanks(RANK_ASSETS);
  for (const [width, left, right] of [[1000, 120, 850], [1600, 192, 1360]]) {
    const svg = buildChartSvg([[1, 50], [2, 54]], ranks, { width, height: 132 });
    assert.match(svg, new RegExp(`<line data-baseline="1" x1="${left}" x2="${right}"`), `plot edges at ${width}px`);
    assert.doesNotMatch(svg, new RegExp(`<rect [^>]*width="${width}" height="132"`), "no full-size background rect");
  }
});

const RANKED = [match(1, 1_700_000_000, 96), match(2, 1_700_100_000, 101), match(3, 1_700_200_000, 104)];
const historyCalls = (urls) => urls.filter((url) => url.includes("-history")).map((url) => url.split("/").pop());

// Failure modes: an outage of the cheap endpoint blanks the tab; a retry on 429 doubles the load on a limited API.
test("mmr-history failures other than 429 fall back to match-history", async () => {
  for (const [name, mmr] of [
    ["404", () => jsonResponse({ detail: "gone" }, 404)],
    ["410", () => jsonResponse({ detail: "gone" }, 410)],
    ["500", () => jsonResponse({}, 500)],
    ["invalid shape", { not: "an array" }],
    ["zero rows", []],
    ["rows without a rank", [{ match_id: 1, start_time: 1_700_000_000 }]],
  ]) {
    const urls = [];
    const chart = page({ fetchImpl: router({ urls, mmr, mh: RANKED }), search: query({ group: "1" }) });
    assert.deepEqual(await chart.run(), { ok: true, points: 3 }, name);
    assert.deepEqual(historyCalls(urls), ["mmr-history", "match-history"], name);
    assert.deepEqual(chart.payload(), { v: 1, request: "q1", kind: "ready", points: 3 }, name);
  }
});

test("a rate limit or an abort on mmr-history never reaches match-history", async () => {
  const urls = [];
  const limited = page({ fetchImpl: router({ urls, mmr: () => jsonResponse({}, 429, { "retry-after": "30" }), mh: RANKED }) });
  assert.equal((await limited.run()).code, "rate_limit");
  assert.deepEqual(limited.payload(), { v: 1, request: "q1", kind: "error", code: "rate_limit" });
  assert.deepEqual(historyCalls(urls), ["mmr-history"]);
  assert.equal(limited.storage.getItem(MMR_DOWN_KEY), null, "a rate limit is not an outage");

  const abortedUrls = [];
  const controller = new AbortController();
  const base = router({ urls: abortedUrls, mmr: RANKED, mh: RANKED });
  const aborted = page({
    fetchImpl: async (url) => {
      if (!url.includes("/mmr-history")) return base(url);
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.deepEqual(await aborted.run({ signal: controller.signal }), { ok: false, code: "aborted" });
  assert.equal(aborted.documentRef.title, "");
  assert.ok(!abortedUrls.some((url) => url.includes("/match-history")), "no match-history call after an abort");
  assert.equal(aborted.storage.getItem(MMR_DOWN_KEY), null);
});

test("a remembered mmr-history failure skips it for one hour, then retries", async () => {
  const urls = [];
  const storage = new MemoryStorage();
  let clock = T0;
  const fetchImpl = router({ urls, mmr: () => jsonResponse({}, 404), mh: RANKED });
  const run = () => page({ fetchImpl, storage, now: () => clock }).run();
  await run();
  assert.deepEqual(historyCalls(urls), ["mmr-history", "match-history"]);
  assert.ok(storage.getItem(MMR_DOWN_KEY), "the failure is remembered");

  clock = T0 + 6 * 60 * 1000; // history cache expired, outage still remembered
  urls.length = 0;
  assert.equal((await run()).ok, true);
  assert.deepEqual(historyCalls(urls), ["match-history"], "within the hour mmr-history is not requested");

  clock = T0 + HOUR + 1000;
  urls.length = 0;
  await run();
  assert.deepEqual(historyCalls(urls), ["mmr-history", "match-history"], "after the hour it is retried");
});

test("a successful mmr-history run remembers nothing, and malformed storage is ignored", async () => {
  const urls = [];
  const fetchImpl = router({ urls, mmr: RANKED.map((row) => mmrRow(row.match_id, row.start_time, row.ranked_display_badge)), mh: () => { throw new Error("unused"); } });
  const healthy = page({ fetchImpl });
  await healthy.run();
  assert.equal(healthy.storage.getItem(MMR_DOWN_KEY), null);
  for (const garbage of ["not json", "null", "42", "{}", '{"t":"x"}', '{"value":1}', `{"t":${T0 + HOUR},"value":1}`, `{"t":${T0},"value":null}`]) {
    const storage = new MemoryStorage();
    storage.setItem(MMR_DOWN_KEY, garbage);
    urls.length = 0;
    assert.equal((await page({ fetchImpl, storage }).run()).ok, true, garbage);
    assert.deepEqual(historyCalls(urls), ["mmr-history"], `malformed state ${garbage} does not suppress mmr-history`);
  }
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {}, key() { return null; }, length: 0 };
  assert.equal((await page({ fetchImpl: router({ mmr: () => jsonResponse({}, 404), mh: RANKED }), storage: broken }).run()).ok, true, "unusable storage never blocks the chart");
});

// Failure mode: two sequential 20 s timeouts leave the Panorama tab waiting 40 s.
test("both history calls share one 20 s budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let failMmr;
  const fetchImpl = (url) => {
    if (url.includes("/assets/ranks")) return Promise.resolve(jsonResponse(RANK_ASSETS));
    if (url.includes("/mmr-history")) return new Promise((resolve) => { failMmr = () => resolve(jsonResponse({}, 500)); });
    return new Promise(() => {});
  };
  const chart = page({ fetchImpl });
  let result = null;
  const finished = chart.run().then((value) => { result = value; });
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  await turn();
  t.mock.timers.tick(15_000);
  failMmr();
  await turn();
  t.mock.timers.tick(4_900);
  await turn();
  assert.equal(result, null, "match-history still has its remaining 5 s");
  t.mock.timers.tick(100);
  await finished;
  assert.equal(result.ok, false);
  assert.deepEqual(chart.payload(), { v: 1, request: "q1", kind: "error", code: "network_error" });
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  AXES,
  PLAY_TITLE_PREFIX,
  buildRadarSvg,
  cohortStart,
  earlyImpactScore,
  normalCdf,
  parsePlaystyleQuery,
  playstyleUrls,
  runPlaystyle,
  scoreAxes,
} from "../src/playstyle.js";

const NOW = Date.UTC(2026, 9, 19, 15, 30);
const SINCE = cohortStart(NOW);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  key(index) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

function quantiles(p50, spread) {
  const entry = { avg: p50 };
  for (const [p, offset] of [[1, -2], [5, -1.6], [10, -1.3], [25, -0.7], [50, 0], [75, 0.7], [90, 1.3], [95, 1.6], [99, 2]]) {
    entry[`percentile${p}`] = Math.max(0, p50 + offset * spread);
  }
  return entry;
}

const COMMUNITY_METRICS = {
  player_damage_per_min: quantiles(850, 300),
  net_worth_per_min: quantiles(1100, 200),
  player_damage_taken_per_min: quantiles(900, 250),
  player_healing_per_min: quantiles(240, 150),
  boss_damage_per_min: quantiles(125, 90),
};
const ACCOUNT_METRICS = {
  player_damage_per_min: { avg: 1100 },
  net_worth_per_min: { avg: 1100 },
  player_damage_taken_per_min: { avg: 700 },
  player_healing_per_min: { avg: 240 },
  boss_damage_per_min: { avg: 400 },
};
function curvePoint(time, nw, nwStd, k, kStd, a, aStd) {
  return { game_time: time, net_worth_avg: nw, net_worth_std: nwStd, kills_avg: k, kills_std: kStd, assists_avg: a, assists_std: aStd };
}
const COMMUNITY_CURVE = [curvePoint(360, 3000, 600, 0.5, 0.8, 0.5, 0.8), curvePoint(540, 6000, 960, 1.2, 1.3, 1.2, 1.3), curvePoint(720, 8880, 1430, 1.7, 1.7, 2.0, 1.7)];
const ACCOUNT_CURVE = [curvePoint(540, 7300, 1330, 1.4, 1.2, 1.3, 1.3), curvePoint(720, 11310, 1870, 2.0, 1.4, 2.1, 1.8)];

function jsonResponse(data, status = 200, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Map(Object.entries({ "content-type": "application/json", ...headers })), text: async () => JSON.stringify(data) };
}

function api(overrides = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const account = url.includes("account_ids=");
    if (url.includes("player-performance-curve")) return overrides.curve ? overrides.curve(account) : jsonResponse(account ? ACCOUNT_CURVE : COMMUNITY_CURVE);
    return overrides.metrics ? overrides.metrics(account) : jsonResponse(account ? ACCOUNT_METRICS : COMMUNITY_METRICS);
  };
  return { urls, fetchImpl };
}

function page({ fetchImpl, search = "?protocol=1&request=p1&account_id=487348881", storage = new MemoryStorage(), now = () => NOW } = {}) {
  const documentRef = { title: "", body: { innerHTML: "" } };
  const locationRef = { search, hash: "" };
  return {
    documentRef, storage,
    run: (extra = {}) => runPlaystyle({ documentRef, locationRef, fetchImpl, storage, now, viewport: { width: 400, height: 260 }, ...extra }),
    payload() {
      assert.ok(documentRef.title.startsWith(PLAY_TITLE_PREFIX), documentRef.title);
      assert.equal(decodeURIComponent(locationRef.hash), documentRef.title);
      return JSON.parse(documentRef.title.slice(PLAY_TITLE_PREFIX.length));
    },
  };
}

test("query accepts only protocol, nonce and canonical account", () => {
  assert.deepEqual(parsePlaystyleQuery("?protocol=1&request=p1&account_id=487348881"), { request: "p1", account: 487348881 });
  for (const bad of ["?protocol=2&request=p1&account_id=1", "?protocol=1&request=&account_id=1", "?protocol=1&request=p1&account_id=0", "?protocol=1&request=p1&account_id=01"]) {
    assert.equal(parsePlaystyleQuery(bad), null, bad);
  }
});

test("both cohorts use the same day-bucketed 30-day window and modes, and never max_matches", () => {
  assert.equal(SINCE % 86400, 0);
  assert.equal(cohortStart(NOW + 3600 * 1000), SINCE, "the window start is stable within a day");
  const urls = playstyleUrls(487348881, SINCE);
  for (const url of Object.values(urls)) {
    assert.match(url, new RegExp(`min_unix_timestamp=${SINCE}`));
    assert.match(url, /match_mode=ranked%2Cunranked|match_mode=ranked,unranked/);
    assert.doesNotMatch(url, /max_matches/);
  }
  assert.match(urls.accountMetrics, /account_ids=487348881/);
  assert.doesNotMatch(urls.communityMetrics, /account_ids/);
  assert.match(urls.accountCurve, /resolution=0/);
});

test("normal CDF is symmetric and bounded", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1) + normalCdf(1) - 1) < 1e-6);
});

test("early impact interpolates 10:00 between the 9:00 and 12:00 samples", () => {
  const score = earlyImpactScore(ACCOUNT_CURVE, COMMUNITY_CURVE);
  assert.ok(score > 50 && score < 99, `an above-average early game scores above 50: ${score}`);
  const same = earlyImpactScore(COMMUNITY_CURVE, COMMUNITY_CURVE);
  assert.ok(Math.abs(same - 50) < 1e-9, "matching the community mean scores 50");
  assert.equal(earlyImpactScore([ACCOUNT_CURVE[1]], COMMUNITY_CURVE), null, "a missing 9:00 sample is unavailable, not zero");
  assert.equal(earlyImpactScore(ACCOUNT_CURVE, [curvePoint(540, 6000, 0, 1, 0, 1, 0), curvePoint(720, 8880, 0, 1.7, 0, 2, 0)]), null, "zero spread is unavailable");
});

test("axis scores are community quantile positions; missing data stays null", () => {
  const axes = scoreAxes({ accountMetrics: ACCOUNT_METRICS, communityMetrics: COMMUNITY_METRICS, accountCurve: ACCOUNT_CURVE, communityCurve: COMMUNITY_CURVE });
  assert.deepEqual(axes.map((axis) => axis.id), AXES.map((axis) => axis.id));
  assert.deepEqual(AXES.map((axis) => axis.label), ["DAMAGE DEALER", "FARMING", "TANK", "SUPPORT", "EARLY IMPACT", "PUSHER"]);
  const byId = Object.fromEntries(axes.map((axis) => [axis.id, axis.score]));
  assert.equal(byId.farming, 50, "an average equal to the community median scores 50");
  assert.equal(byId.support, 50);
  assert.ok(byId.damage > 50 && byId.tank < 50 && byId.pusher > 90);
  const partial = scoreAxes({ accountMetrics: { ...ACCOUNT_METRICS, player_healing_per_min: { avg: null } }, communityMetrics: COMMUNITY_METRICS, accountCurve: [], communityCurve: COMMUNITY_CURVE });
  assert.equal(partial.find((axis) => axis.id === "support").score, null);
  assert.equal(partial.find((axis) => axis.id === "early").score, null);
});

test("radar svg draws the polygon only with all six scores and highlights the top axis", () => {
  const axes = AXES.map((axis, index) => ({ ...axis, score: [80, 60, 40, 20, 30, 95][index] }));
  const svg = buildRadarSvg(axes, { width: 400, height: 260 });
  assert.equal((svg.match(/<polygon /g) || []).length, 5, "four grid rings plus the score polygon");
  assert.equal((svg.match(/<circle /g) || []).length, 6);
  assert.match(svg, /fill="#7ee2a8"[^>]*>PUSHER</, "the highest axis label is green");
  const partial = buildRadarSvg(axes.map((axis) => (axis.id === "early" ? { ...axis, score: null } : axis)), { width: 400, height: 260 });
  assert.equal((partial.match(/<polygon /g) || []).length, 4, "no filled polygon when an axis is unavailable");
  assert.match(partial, /EARLY IMPACT<\/text><text[^>]*>N\/A/);
  assert.match(partial, /LAST 30 DAYS/);
});

test("run renders, caches community data, and reuses account data", async () => {
  const { urls, fetchImpl } = api();
  const first = page({ fetchImpl });
  assert.deepEqual(await first.run(), { ok: true, axes: 6 });
  assert.deepEqual(first.payload(), { v: 1, request: "p1", kind: "ready", axes: 6 });
  assert.match(first.documentRef.body.innerHTML, /<svg /);
  assert.equal(urls.length, 4);
  const other = page({ fetchImpl, storage: first.storage, search: "?protocol=1&request=p2&account_id=1424351890" });
  await other.run();
  assert.equal(urls.length, 6, "another account reuses the cached community cohort");
  const again = page({ fetchImpl, storage: first.storage });
  await again.run();
  assert.equal(urls.length, 6, "the same account inside ten minutes makes no requests");
});

test("no matches, failures and invalid queries publish typed titles", async () => {
  const nulls = Object.fromEntries(Object.keys(ACCOUNT_METRICS).map((key) => [key, { avg: null }]));
  const empty = page({ fetchImpl: api({ metrics: (account) => jsonResponse(account ? nulls : COMMUNITY_METRICS), curve: (account) => jsonResponse(account ? [] : COMMUNITY_CURVE) }).fetchImpl });
  await empty.run();
  assert.deepEqual(empty.payload(), { v: 1, request: "p1", kind: "empty", axes: 0 });
  assert.match(empty.documentRef.body.innerHTML, /No matches in the last 30 days/);
  for (const [overrides, code] of [
    [{ metrics: () => jsonResponse({}, 429) }, "rate_limit"],
    [{ curve: () => jsonResponse({}, 500) }, "upstream_error"],
    [{ metrics: () => jsonResponse([1, 2]) }, "invalid_payload"],
  ]) {
    const failed = page({ fetchImpl: api(overrides).fetchImpl });
    await failed.run();
    assert.deepEqual(failed.payload(), { v: 1, request: "p1", kind: "error", code });
  }
  const invalid = page({ fetchImpl: async () => { throw new Error("must not fetch"); }, search: "?protocol=1&request=p1" });
  await invalid.run();
  assert.deepEqual(invalid.payload(), { v: 1, request: "", kind: "error", code: "invalid_query" });
});

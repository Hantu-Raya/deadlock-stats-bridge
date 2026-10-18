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
import { readCooldown, writeCooldown } from "../src/page-cache.js";

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
  const size = { width: 400, height: 260 };
  const resizeTarget = new EventTarget();
  return {
    documentRef, storage, size,
    resize(width, height) { Object.assign(size, { width, height }); resizeTarget.dispatchEvent(new Event("resize")); },
    run: (extra = {}) => runPlaystyle({ documentRef, locationRef, fetchImpl, storage, now, viewport: () => ({ ...size }), resizeTarget, ...extra }),
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

const communityUrls = (urls) => urls.filter((url) => !url.includes("account_ids="));

test("a successful resource is cached even when its sibling fails, so only the failed one is refetched", async () => {
  const failing = { on: true };
  const { urls, fetchImpl } = api({
    curve: (account) => (account && failing.on ? jsonResponse({}, 500) : jsonResponse(account ? ACCOUNT_CURVE : COMMUNITY_CURVE)),
  });
  const storage = new MemoryStorage();
  const first = page({ fetchImpl, storage });
  await first.run();
  assert.deepEqual(first.payload(), { v: 1, request: "p1", kind: "error", code: "upstream_error" });
  assert.equal(urls.length, 4);
  failing.on = false;
  const second = page({ fetchImpl, storage });
  assert.deepEqual(await second.run(), { ok: true, axes: 6 });
  assert.equal(urls.length, 5, "only the account curve is requested again");
  assert.match(urls[4], /player-performance-curve/);
  assert.match(urls[4], /account_ids=/);
  assert.equal(second.payload().kind, "ready");
});

test("five different accounts fetch the community pair once", async () => {
  const { urls, fetchImpl } = api();
  const storage = new MemoryStorage();
  for (const account of [11, 22, 33, 44, 55]) {
    const radar = page({ fetchImpl, storage, search: `?protocol=1&request=p${account}&account_id=${account}` });
    assert.deepEqual(await radar.run(), { ok: true, axes: 6 });
  }
  assert.equal(communityUrls(urls).length, 2, "community metrics and curve are fetched once each");
  assert.equal(urls.length - communityUrls(urls).length, 10, "every account fetches its own pair");
});

test("concurrent runs share one in-flight request per resource", async () => {
  const { urls, fetchImpl } = api();
  const storage = new MemoryStorage();
  const one = page({ fetchImpl, storage });
  const two = page({ fetchImpl, storage, search: "?protocol=1&request=p2&account_id=487348881" });
  await Promise.all([one.run(), two.run()]);
  assert.equal(urls.length, 4);
  assert.equal(one.payload().kind, "ready");
  assert.equal(two.payload().kind, "ready");
});

test("a 429 cools down the analytics family for Retry-After seconds, defaulting to 60", async () => {
  for (const [headers, seconds] of [[{ "retry-after": "30" }, 30], [{}, 60]]) {
    const limited = { on: true };
    const { urls, fetchImpl } = api({
      curve: (account) => (account && limited.on ? jsonResponse({}, 429, headers) : jsonResponse(account ? ACCOUNT_CURVE : COMMUNITY_CURVE)),
    });
    const storage = new MemoryStorage();
    const first = page({ fetchImpl, storage });
    await first.run();
    assert.deepEqual(first.payload(), { v: 1, request: "p1", kind: "error", code: "rate_limit" });
    assert.equal(urls.length, 4);
    limited.on = false;
    const during = page({ fetchImpl, storage, now: () => NOW + seconds * 1000 - 1000 });
    assert.deepEqual(await during.run(), { ok: false, code: "rate_limit" });
    assert.equal(urls.length, 4, `no request ${seconds - 1} s into the cooldown`);
    assert.deepEqual(during.payload(), { v: 1, request: "p1", kind: "error", code: "rate_limit" });
    assert.match(during.documentRef.body.innerHTML, /the stats service is busy/);
    const after = page({ fetchImpl, storage, now: () => NOW + seconds * 1000 });
    assert.deepEqual(await after.run(), { ok: true, axes: 6 });
    assert.equal(urls.length, 5, "after the cooldown only the missing resource is fetched");
    assert.equal(after.payload().kind, "ready");
  }
});

test("resources already cached still render during a cooldown", async () => {
  const { urls, fetchImpl } = api();
  const storage = new MemoryStorage();
  await page({ fetchImpl, storage }).run();
  writeCooldown(storage, "analytics", NOW + 60_000);
  const during = page({ fetchImpl, storage, now: () => NOW + 1000 });
  assert.deepEqual(await during.run(), { ok: true, axes: 6 });
  assert.equal(urls.length, 4);
  assert.match(during.documentRef.body.innerHTML, /<svg /);
});

test("cooldown storage reports remaining milliseconds and tolerates bad data", () => {
  const storage = new MemoryStorage();
  assert.equal(readCooldown(storage, "analytics", NOW), 0);
  writeCooldown(storage, "analytics", NOW + 30_000);
  assert.equal(readCooldown(storage, "analytics", NOW + 10_000), 20_000);
  assert.equal(readCooldown(storage, "analytics", NOW + 30_000), 0);
  assert.equal(readCooldown(storage, "other", NOW), 0, "families are independent");
  for (const key of [...storage.values.keys()]) storage.setItem(key, "{not json");
  assert.equal(readCooldown(storage, "analytics", NOW), 0);
  assert.equal(readCooldown(null, "analytics", NOW), 0);
  assert.doesNotThrow(() => writeCooldown(null, "analytics", NOW + 1000));
});

test("an aborted run publishes nothing and stores nothing", async () => {
  const controller = new AbortController();
  const radar = page({ fetchImpl: () => { controller.abort(); return new Promise(() => {}); } });
  assert.deepEqual(await radar.run({ signal: controller.signal }), { ok: false, code: "aborted" });
  assert.equal(radar.documentRef.title, "");
  assert.equal(radar.storage.length, 0);
});

test("corrupted cached entries are ignored and refetched", async () => {
  const { urls, fetchImpl } = api();
  const storage = new MemoryStorage();
  await page({ fetchImpl, storage }).run();
  assert.equal(urls.length, 4);
  const keyFor = (scope, kind) => [...storage.values.keys()].find((key) => key.includes(scope) && key.includes(kind));
  storage.setItem(keyFor("account", "metrics"), "{not json");
  storage.setItem(keyFor("community", "curve"), JSON.stringify({ t: NOW, value: "junk" }));
  const again = page({ fetchImpl, storage });
  assert.deepEqual(await again.run(), { ok: true, axes: 6 });
  assert.equal(urls.length, 6, "exactly the two corrupted resources are fetched again");
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

// Failure modes: the browser can start at 0x0 or a stale size before Panorama lays the card out; a fast cached
// render would then stay mis-sized. A resize must redraw without republishing or replacing a message.
test("the radar redraws at the browser's current size and survives a zero-size start", async () => {
  const { fetchImpl } = api();
  const radar = page({ fetchImpl });
  radar.size.width = 0; radar.size.height = 0;
  await radar.run();
  assert.match(radar.documentRef.body.innerHTML, /<svg [^>]*width="400" height="260"/, "a zero-size browser draws at the fallback size");
  const title = radar.documentRef.title;
  radar.resize(360, 300);
  assert.match(radar.documentRef.body.innerHTML, /<svg [^>]*width="360" height="300"/, "a resize redraws at the laid-out size");
  assert.equal(radar.documentRef.title, title, "a redraw does not republish the status");
  const failed = page({ fetchImpl: async () => jsonResponse({}, 500) });
  await failed.run();
  failed.resize(360, 300);
  assert.match(failed.documentRef.body.innerHTML, /Playstyle unavailable/, "a resize never replaces the error text");
});

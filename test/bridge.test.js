import test from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../src/api.js";
import { publishTitle, runBridge, startBridgePage } from "../src/bridge.js";
import { parseBridgeTitle } from "../src/title-protocol.js";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }
}

function analysis(sampleSize = 3) {
  return {
    sampleSize,
    metrics: [
      ["kd", 2.345, 1.234],
      ["kda", 3.456, 2.345],
      ["average-kills", 4.567, 3.456],
      ["average-assists", 5.678, 4.567],
      ["average-deaths", 1.234, 2.345],
      ["damage-taken-per-minute", 6.789, 5.678],
      ["player-damage-per-minute", 7.891, 6.789],
      ["accuracy", 0.4567, 0.5678],
      ["critical-hit-rate", 0.1234, 0.2345],
      ["net-worth-per-minute", 8.912, 7.891],
      ["boss-damage-per-minute", 9.123, 8.912],
      ["healing-per-minute", 10.234, 9.123],
    ].map(([id, value, communityValue]) => ({ id, value, communityValue })),
  };
}

function metadataRows(accountId, count = 150) {
  return Array.from({ length: count }, (_, index) => ({
    duration_s: 600,
    players: [
      {
        account_id: accountId,
        team: 1,
        kills: 10 + (index % 2),
        deaths: 2,
        assists: 4,
        net_worth: 100,
        player_damage: 1000,
        player_damage_taken: 500,
        boss_damage: 100,
        self_healing: 20,
        shots_hit: 80,
        shots_missed: 20,
        hero_bullets_hit_crit: 10,
        hero_bullets_hit: 100,
        mvp_rank: 1,
      },
      { account_id: accountId + 1, team: 1, kills: 8 },
    ],
  }));
}

function metadataEnvelope(accountId, count = 150) {
  return { status: 200, headers: {}, data: metadataRows(accountId, count) };
}

function communityEnvelope(metrics = { kd: { avg: 2 } }) {
  return { status: 200, headers: {}, data: { metrics } };
}

function fresh(value, ageMs = 0) {
  return { freshness: "fresh", ageMs, value };
}

function stale(value, ageMs = 11 * 60 * 1000) {
  return { freshness: "stale", ageMs, value };
}

function playerValue(accountId = 123, mode = "ranked", maxMatches = 150) {
  return {
    accountId,
    mode,
    maxMatches,
    fetchedAt: "2026-08-25T00:00:00.000Z",
    samples: Object.fromEntries(
      [50, 100, 150]
        .filter((limit) => limit <= maxMatches)
        .map((limit) => [String(limit), analysis(3)]),
    ),
  };
}

function communityValue(mode = "ranked", scope = "50") {
  return {
    mode,
    scope,
    metrics: { kd: { avg: 2 } },
    fetchedAt: "2026-08-25T00:00:00.000Z",
  };
}

function titleDocument() {
  const writes = [];
  return {
    writes,
    get title() {
      return writes.at(-1) ?? "Deadlock Stats Bridge";
    },
    set title(value) {
      writes.push(value);
    },
  };
}

const ownDirect = async ({ run }) => ({ owned: true, value: await run() });

test("invalid queries publish a DLSTATS2 invalid_query payload without requests", async () => {
  const location = { search: "?account_id=123&matches=25&mode=ranked&request=req_invalid" };
  const documentRef = titleDocument();
  let metadataRequests = 0;
  let communityRequests = 0;
  const result = await runBridge({
    location,
    documentRef,
    fetchMetadata: async () => {
      metadataRequests += 1;
      return metadataEnvelope(123);
    },
    fetchCommunity: async () => {
      communityRequests += 1;
      return communityEnvelope();
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_query");
  assert.equal(metadataRequests, 0);
  assert.equal(communityRequests, 0);
  assert.equal(result.title.startsWith("DLSTATS2:"), true);
  assert.deepEqual(parseBridgeTitle(result.title).payload, {
    v: 2,
    kind: "error",
    request: "req_invalid",
    account: 123,
    matches: 50,
    mode: "ranked",
    code: "invalid_query",
    message: "Invalid bridge request.",
  });
  assert.equal(documentRef.title, result.title);
  assert.equal(location.hash, encodeURIComponent(result.title));
});


test("protocol 3 invalid queries publish v3 errors", async () => {
  const result = await runBridge({
    location: { search: "?account_id=123&matches=25&mode=ranked&request=req_invalid_v3&protocol=3" },
    documentRef: titleDocument(),
    fetchMetadata: async () => { throw new Error("metadata should not be requested"); },
    fetchCommunity: async () => { throw new Error("community should not be requested"); },
  });
  assert.equal(result.ok, false);
  assert.equal(parseBridgeTitle(result.title).payload.v, 3);
});
test("fresh player and community caches serve a 50-match request without network requests", async () => {
  const location = { search: "?account_id=123&matches=50&mode=ranked&request=req_cache" };
  const documentRef = titleDocument();
  const storage = new MemoryStorage();
  let metadataRequests = 0;
  let communityRequests = 0;
  const result = await runBridge({
    location,
    documentRef,
    storage,
    now: () => 10_000,
    readPlayer: (_storage, account, mode, now) => {
      assert.deepEqual({ account, mode, now }, { account: 123, mode: "ranked", now: 10_000 });
      return fresh(playerValue(account, mode));
    },
    readCommunity: (_storage, mode, scope, now) => {
      assert.deepEqual({ mode, scope, now }, { mode: "ranked", scope: "50", now: 10_000 });
      return fresh(communityValue(mode, scope));
    },
    fetchMetadata: async () => {
      metadataRequests += 1;
      return metadataEnvelope(123);
    },
    fetchCommunity: async () => {
      communityRequests += 1;
      return communityEnvelope();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "cache");
  assert.equal(metadataRequests, 0);
  assert.equal(communityRequests, 0);
  assert.equal(parseBridgeTitle(result.title).payload.kind, "profile_stats");
  assert.equal(parseBridgeTitle(result.title).payload.v, 2);
  assert.equal(documentRef.title, result.title);
  assert.equal(location.hash, encodeURIComponent(result.title));
});

test("protocol 3 requests publish percentile-shaped metrics", async () => {
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_v3&protocol=3" },
    documentRef: titleDocument(),
    now: () => 10_000,
    readPlayer: () => fresh(playerValue()),
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    fetchMetadata: async () => { throw new Error("metadata should not be requested"); },
    fetchCommunity: async () => { throw new Error("community should not be requested"); },
  });

  assert.equal(result.ok, true);
  const payload = parseBridgeTitle(result.title).payload;
  assert.equal(payload.v, 3);
  assert.ok(payload.groups.every((group) => group.metrics.every((metric) => (
    Object.keys(metric).join(",") === "id,player,community,percentile"
  ))));
});

test("malformed fresh player cache falls through to metadata and preserves the community cache", async () => {
  const documentRef = titleDocument();
  let metadataRequests = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_bad_cache" },
    documentRef,
    now: () => 10_000,
    readPlayer: () => fresh({
      accountId: 123,
      mode: "ranked",
      maxMatches: 150,
      samples: { "50": { sampleSize: 1, metrics: [] } },
    }),
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    fetchMetadata: async ({ accountId, limit, mode }) => {
      metadataRequests += 1;
      assert.deepEqual({ accountId, limit, mode }, { accountId: 123, limit: 150, mode: "ranked" });
      return metadataEnvelope(accountId);
    },
    fetchCommunity: async () => {
      throw new Error("community cache should satisfy this request");
    },
    writePlayer: () => true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "network");
  assert.equal(metadataRequests, 1);
});

test("aborted bridge requests publish no title or resource request", async () => {
  const documentRef = titleDocument();
  const controller = new AbortController();
  controller.abort();
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_abort" },
    documentRef,
    signal: controller.signal,
    fetchMetadata: async () => {
      throw new Error("metadata must stay idle");
    },
    fetchCommunity: async () => {
      throw new Error("community must stay idle");
    },
  });

  assert.deepEqual(result, { ok: false, aborted: true });
  assert.deepEqual(documentRef.writes, []);
});

test("abort after metadata resolves prevents player cache and title writes", async () => {
  const documentRef = titleDocument();
  const controller = new AbortController();
  let playerWrites = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_abort_metadata" },
    documentRef,
    signal: controller.signal,
    readPlayer: () => null,
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    fetchMetadata: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return metadataEnvelope(123);
    },
    writePlayer: () => {
      playerWrites += 1;
      return true;
    },
  });

  assert.deepEqual(result, { ok: false, aborted: true });
  assert.equal(playerWrites, 0);
  assert.deepEqual(documentRef.writes, []);
});

test("pagehide aborts the bridge request and removes its listener", async () => {
  const listeners = new Map();
  const windowRef = {
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const started = startBridgePage({
    windowRef,
    run: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, aborted: true }), { once: true });
    }),
  });

  await Promise.resolve();
  listeners.get("pagehide")();
  assert.deepEqual(await started.promise, { ok: false, aborted: true });
  assert.equal(started.controller.signal.aborted, true);
  assert.equal(listeners.has("pagehide"), false);
});

test("stale player cache is bypassed and a successful metadata result is cached", async () => {
  const documentRef = titleDocument();
  let metadataRequests = 0;
  let playerWrites = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=100&mode=standard&request=req_stale_refresh" },
    documentRef,
    now: () => 10_000,
    own: ownDirect,
    readPlayer: () => stale(playerValue(123, "standard")),
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    fetchMetadata: async ({ accountId, limit, mode }) => {
      metadataRequests += 1;
      assert.deepEqual({ accountId, limit, mode }, { accountId: 123, limit: 150, mode: "standard" });
      return metadataEnvelope(accountId);
    },
    writePlayer: (_storage, accountId, mode, value) => {
      playerWrites += 1;
      assert.deepEqual({ accountId, mode }, { accountId: 123, mode: "standard" });
      assert.equal(value.samples["100"].sampleSize, 100);
      return true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "network");
  assert.equal(metadataRequests, 1);
  assert.equal(playerWrites, 1);
});

test("API failures emit an allowlisted DLSTATS2 error without raw detail", async () => {
  const location = { search: "?account_id=123&matches=150&mode=standard&request=req_429" };
  const documentRef = titleDocument();
  const result = await runBridge({
    location,
    documentRef,
    readPlayer: () => null,
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    fetchMetadata: async () => {
      throw new ApiError("request failed", {
        status: 429,
        retryAfter: "5",
        detail: "secret response body",
      });
    },
    own: ownDirect,
  });
  const parsed = parseBridgeTitle(result.title);
  assert.equal(result.ok, false);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload, {
    v: 2,
    kind: "error",
    request: "req_429",
    account: 123,
    matches: 150,
    mode: "standard",
    code: "rate_limit",
    status: 429,
    retry_after: 5,
    message: "The stats service is rate limited.",
  });
  assert.equal(result.title.includes("secret response body"), false);
  assert.equal(documentRef.title, result.title);
  assert.equal(location.hash, encodeURIComponent(result.title));
});

test("publishTitle persists the encoded DLSTATS2 title", () => {
  const documentRef = titleDocument();
  const locationRef = {};
  const title = "DLSTATS2:{\"v\":2}";
  const didAssign = publishTitle(title, { documentRef, locationRef });

  assert.equal(didAssign, true);
  assert.equal(documentRef.title, title);
  assert.equal(locationRef.hash, encodeURIComponent(title));
});

test("same-page concurrent requests deduplicate metadata and community resources", async () => {
  const storage = new MemoryStorage();
  const playerEntries = new Map();
  const communityEntries = new Map();
  const metadataRequests = [];
  const communityRequests = [];
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  let metadataStarted;
  const metadataStartedPromise = new Promise((resolve) => {
    metadataStarted = resolve;
  });

  const makeOptions = (request) => ({
    location: { search: `?account_id=123&matches=50&mode=ranked&request=${request}` },
    documentRef: titleDocument(),
    storage,
    now: () => 10_000,
    own: ownDirect,
    readPlayer: (_storage, account, mode) => playerEntries.get(`${account}:${mode}`) ?? null,
    writePlayer: (_storage, account, mode, value) => {
      playerEntries.set(`${account}:${mode}`, fresh(value));
      return true;
    },
    readCommunity: (_storage, mode, scope) => communityEntries.get(`${mode}:${scope}`) ?? null,
    writeCommunity: (_storage, mode, scope, value) => {
      communityEntries.set(`${mode}:${scope}`, fresh(value));
      return true;
    },
    fetchMetadata: async ({ accountId, limit, mode }) => {
      metadataRequests.push({ accountId, limit, mode });
      metadataStarted();
      await metadataGate;
      return metadataEnvelope(accountId);
    },
    fetchCommunity: async ({ mode, metricsLimit }) => {
      communityRequests.push({ mode, metricsLimit });
      return communityEnvelope();
    },
  });

  const first = runBridge(makeOptions("req_same_a"));
  const second = runBridge(makeOptions("req_same_b"));
  await metadataStartedPromise;
  assert.equal(metadataRequests.length, 1);
  assert.equal(communityRequests.length, 1);
  releaseMetadata();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(parseBridgeTitle(firstResult.title).payload.request, "req_same_a");
  assert.equal(parseBridgeTitle(secondResult.title).payload.request, "req_same_b");
});

test("a larger player prefix cache satisfies a smaller bridge request", async () => {
  const documentRef = titleDocument();
  let metadataRequests = 0;
  let communityRequests = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_prefix" },
    documentRef,
    now: () => 15_000,
    readPlayer: () => fresh(playerValue(123, "ranked", 150)),
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    fetchMetadata: async () => {
      metadataRequests += 1;
      return metadataEnvelope(123);
    },
    fetchCommunity: async () => {
      communityRequests += 1;
      return communityEnvelope();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "cache");
  assert.equal(metadataRequests, 0);
  assert.equal(communityRequests, 0);
  assert.equal(parseBridgeTitle(result.title).payload.matches, 50);
});

test("community cache reuse crosses accounts while metadata stays account-specific", async () => {
  const storage = new MemoryStorage();
  const playerCache = new Map();
  const communityCache = new Map();
  const metadataRequests = [];
  let communityFetches = 0;
  const run = (accountId, request) => runBridge({
    location: { search: `?account_id=${accountId}&matches=50&mode=ranked&request=${request}` },
    documentRef: titleDocument(),
    storage,
    now: () => 20_000,
    own: ownDirect,
    readPlayer: (_storage, account, mode) => playerCache.get(`${account}:${mode}`) ?? null,
    writePlayer: (_storage, account, mode, value) => {
      playerCache.set(`${account}:${mode}`, fresh(value));
      return true;
    },
    readCommunity: (_storage, mode, scope) => communityCache.get(`${mode}:${scope}`) ?? null,
    writeCommunity: (_storage, mode, scope, value) => {
      communityCache.set(`${mode}:${scope}`, fresh(value));
      return true;
    },
    fetchMetadata: async ({ accountId: id, limit, mode }) => {
      metadataRequests.push({ accountId: id, limit, mode });
      return metadataEnvelope(id);
    },
    fetchCommunity: async ({ mode, metricsLimit }) => {
      communityFetches += 1;
      assert.deepEqual({ mode, metricsLimit }, { mode: "ranked", metricsLimit: 50 });
      return communityEnvelope();
    },
  });

  const first = await run(123, "req_account_first");
  const second = await run(456, "req_account_second");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(metadataRequests, [
    { accountId: 123, limit: 150, mode: "ranked" },
    { accountId: 456, limit: 150, mode: "ranked" },
  ]);
  assert.equal(communityFetches, 1);
});

test("metadata failure does not discard an independently successful community cache write", async () => {
  const communityWrites = [];
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_partial" },
    documentRef: titleDocument(),
    storage: new MemoryStorage(),
    now: () => 30_000,
    own: ownDirect,
    readPlayer: () => null,
    readCommunity: () => null,
    writeCommunity: (_storage, mode, scope, value) => {
      communityWrites.push({ mode, scope, value });
      return true;
    },
    fetchMetadata: async () => {
      throw new ApiError("metadata unavailable", { status: 503, detail: "metadata failed" });
    },
    fetchCommunity: async () => communityEnvelope({ kd: { avg: 2 } }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(communityWrites.map(({ mode, scope }) => ({ mode, scope })), [
    { mode: "ranked", scope: "50" },
  ]);
  assert.equal(parseBridgeTitle(result.title).payload.code, "upstream_error");
});

test("community failure preserves a successful player profile title", async () => {
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_player_only" },
    documentRef: titleDocument(),
    storage: new MemoryStorage(),
    now: () => 30_000,
    own: ownDirect,
    readPlayer: () => null,
    readCommunity: () => null,
    fetchMetadata: async () => metadataEnvelope(123),
    fetchCommunity: async () => {
      throw new ApiError("community unavailable", { status: 503 });
    },
  });

  const parsed = parseBridgeTitle(result.title);
  assert.equal(result.ok, true);
  assert.equal(result.communityError.status, 503);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.kind, "profile_stats");
  assert.equal(parsed.payload.sample, 50);
});

test("persistent metadata cooldown suppresses a second request", async () => {
  const storage = new MemoryStorage();
  let metadataRequests = 0;
  let rateState = null;
  const makeOptions = (request) => ({
    location: { search: `?account_id=123&matches=50&mode=ranked&request=${request}` },
    documentRef: titleDocument(),
    storage,
    now: () => 40_000,
    own: ownDirect,
    readPlayer: () => null,
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    readRate: (_storage, family) => family === "metadata" ? rateState : null,
    updateRate: (_storage, family, _headers, { now, status }) => {
      if (family === "metadata" && status === 429) {
        rateState = { blockedUntil: now + 7_000, lastBlockedUntil: now + 7_000 };
      }
    },
    fetchMetadata: async () => {
      metadataRequests += 1;
      throw new ApiError("metadata rate limited", { status: 429, retryAfter: "7" });
    },
  });

  const first = await runBridge(makeOptions("req_cooldown_first"));
  const second = await runBridge(makeOptions("req_cooldown_second"));

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(metadataRequests, 1);
  assert.equal(parseBridgeTitle(first.title).payload.code, "rate_limit");
  assert.equal(parseBridgeTitle(second.title).payload.code, "rate_limit");
  assert.equal(parseBridgeTitle(second.title).payload.retry_after, 7);
});

test("resource ownership receives distinct player and community keys", async () => {
  const ownershipKeys = [];
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_ownership" },
    documentRef: titleDocument(),
    storage: new MemoryStorage(),
    now: () => 50_000,
    own: async ({ resourceKey, run }) => {
      ownershipKeys.push(resourceKey);
      return { owned: true, value: await run() };
    },
    readPlayer: () => null,
    readCommunity: () => null,
    fetchMetadata: async () => metadataEnvelope(123),
    fetchCommunity: async () => communityEnvelope(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(ownershipKeys.sort(), [
    "community:ranked:50",
    "player:123:ranked",
  ]);
});

test("player mode and community mode/count scopes remain isolated", async () => {
  const playerCache = new Map();
  const communityCache = new Map();
  const metadataRequests = [];
  const communityRequests = [];
  const run = (matches, mode, request) => runBridge({
    location: { search: `?account_id=123&matches=${matches}&mode=${mode}&request=${request}` },
    documentRef: titleDocument(),
    storage: new MemoryStorage(),
    now: () => 60_000,
    own: ownDirect,
    readPlayer: (_storage, account, resourceMode) => playerCache.get(`${account}:${resourceMode}`) ?? null,
    writePlayer: (_storage, account, resourceMode, value) => {
      playerCache.set(`${account}:${resourceMode}`, fresh(value));
      return true;
    },
    readCommunity: (_storage, resourceMode, scope) => communityCache.get(`${resourceMode}:${scope}`) ?? null,
    writeCommunity: (_storage, resourceMode, scope, value) => {
      communityCache.set(`${resourceMode}:${scope}`, fresh(value));
      return true;
    },
    fetchMetadata: async ({ accountId, limit, mode: resourceMode }) => {
      metadataRequests.push({ accountId, limit, mode: resourceMode });
      return metadataEnvelope(accountId);
    },
    fetchCommunity: async ({ mode: resourceMode, metricsLimit }) => {
      communityRequests.push({ mode: resourceMode, scope: String(metricsLimit) });
      return communityEnvelope();
    },
  });

  const ranked50 = await run(50, "ranked", "req_scope_ranked_50");
  const ranked100 = await run(100, "ranked", "req_scope_ranked_100");
  const standard50 = await run(50, "standard", "req_scope_standard_50");
  const ranked50Cached = await run(50, "ranked", "req_scope_ranked_50_again");

  assert.equal(ranked50.ok, true);
  assert.equal(ranked100.ok, true);
  assert.equal(standard50.ok, true);
  assert.equal(ranked50Cached.ok, true);
  assert.deepEqual(metadataRequests, [
    { accountId: 123, limit: 150, mode: "ranked" },
    { accountId: 123, limit: 150, mode: "standard" },
  ]);
  assert.deepEqual(communityRequests, [
    { mode: "ranked", scope: "50" },
    { mode: "ranked", scope: "100" },
    { mode: "standard", scope: "50" },
  ]);
  assert.equal(ranked50Cached.source, "cache");
});

test("stale player result remains usable after a metadata 429", async () => {
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_stale" },
    documentRef: titleDocument(),
    storage: new MemoryStorage(),
    now: () => 70_000,
    readPlayer: () => stale(playerValue(123, "ranked")),
    readCommunity: (_storage, mode, scope) => fresh(communityValue(mode, scope)),
    own: ownDirect,
    fetchMetadata: async () => {
      throw new ApiError("metadata rate limited", { status: 429, retryAfter: "9" });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "stale");
  assert.equal(result.playerError.status, 429);
  assert.equal(parseBridgeTitle(result.title).payload.kind, "profile_stats");
  assert.equal(parseBridgeTitle(result.title).payload.matches, 50);
});

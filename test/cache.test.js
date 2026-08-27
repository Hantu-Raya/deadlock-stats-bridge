import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMUNITY_FRESH_TTL_MS,
  FRESH_TTL_MS,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_SERIALIZED_BYTES,
  STALE_TTL_MS,
  purgeLegacyNamespaces,
  readCommunityCache,
  readPlayerCache,
  readRateState,
  rateCooldownRemaining,
  updateRateState,
  withResourceOwnership,
  writeCommunityCache,
  writePlayerCache,
} from "../src/cache.js";
import { ANALYSIS_METRIC_IDS } from "../src/metrics.js";

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

class QuotaStorage extends MemoryStorage {
  failNext = false;
  setItem(key, value) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("quota exceeded");
    }
    super.setItem(key, value);
  }
}

function sample(size = 1) {
  return {
    sampleSize: size,
    totalDurationSeconds: size * 600,
    metrics: ANALYSIS_METRIC_IDS.map((id) => ({
      id,
      value: 2,
      displayValue: "2.00",
      communityValue: null,
      communityDisplayValue: null,
      percentile: null,
      unit: "ratio",
    })),
    supplemental: { averageMvp: { value: 2, displayValue: "2.00", unit: "rank" } },
  };
}

function playerValue(now, maxMatches = 200, accountId = 50) {
  const samples = {
    "25": sample(1),
    "50": sample(2),
    "100": sample(3),
    "200": sample(5),
  };
  return {
    accountId,
    mode: "ranked",
    maxMatches,
    fetchedAt: new Date(now).toISOString(),
    samples: Object.fromEntries(Object.entries(samples).filter(([key]) => Number(key) <= maxMatches)),
  };
}

test("player cache stores one account/mode superset and reuses prefix samples", () => {
  const storage = new MemoryStorage();
  const now = 2_000_000;
  assert.equal(writePlayerCache(storage, 50, "ranked", playerValue(now), now), true);

  const cached = readPlayerCache(storage, 50, "ranked", now + 1);
  assert.equal(cached.freshness, "fresh");
  assert.equal(cached.value.maxMatches, 200);
  assert.deepEqual(Object.keys(cached.value.samples).sort(), ["100", "200", "25", "50"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(cached.value.samples).map(([key, value]) => [key, value.sampleSize])),
    { "25": 1, "50": 2, "100": 3, "200": 5 },
  );
  assert.equal(readPlayerCache(storage, 50, "standard", now + 1), null);
  assert.equal(readPlayerCache(storage, 51, "ranked", now + 1), null);

  const raw = JSON.parse(storage.getItem("deadlock-stats-player:v2:50:ranked"));
  assert.equal(raw.kind, "player");
  assert.equal(Object.hasOwn(raw, "metadata"), false);
});

test("player and community clocks distinguish fresh, stale, expired, and future entries", () => {
  const now = 3_000_000;
  const playerStorage = new MemoryStorage();
  assert.equal(writePlayerCache(playerStorage, 50, "ranked", playerValue(now), now), true);
  assert.equal(readPlayerCache(playerStorage, 50, "ranked", now + FRESH_TTL_MS - 1).freshness, "fresh");
  assert.equal(readPlayerCache(playerStorage, 50, "ranked", now + FRESH_TTL_MS).freshness, "stale");
  assert.equal(readPlayerCache(playerStorage, 50, "ranked", now + STALE_TTL_MS), null);

  const playerKey = "deadlock-stats-player:v2:50:ranked";
  playerStorage.setItem(playerKey, JSON.stringify({
    kind: "player",
    accountId: 50,
    mode: "ranked",
    maxMatches: 200,
    samples: playerValue(now).samples,
    savedAt: now + 1,
    fetchedAt: new Date(now).toISOString(),
  }));
  assert.equal(readPlayerCache(playerStorage, 50, "ranked", now), null);
  playerStorage.setItem(playerKey, JSON.stringify({
    kind: "player",
    accountId: 50,
    mode: "ranked",
    maxMatches: 200,
    samples: playerValue(now).samples,
    savedAt: now,
    fetchedAt: new Date(now + 1).toISOString(),
  }));
  assert.equal(readPlayerCache(playerStorage, 50, "ranked", now), null);

  const communityStorage = new MemoryStorage();
  assert.equal(writeCommunityCache(
    communityStorage,
    "ranked",
    "all",
    { metrics: { kd: { avg: 2 } }, fetchedAt: new Date(now).toISOString() },
    now,
  ), true);
  assert.equal(readCommunityCache(communityStorage, "ranked", "all", now + COMMUNITY_FRESH_TTL_MS - 1).freshness, "fresh");
  assert.equal(readCommunityCache(communityStorage, "ranked", "all", now + COMMUNITY_FRESH_TTL_MS).freshness, "stale");
  assert.equal(readCommunityCache(communityStorage, "ranked", "all", now + STALE_TTL_MS), null);

  const communityKey = "deadlock-stats-community:v3:ranked:all";
  communityStorage.setItem(communityKey, JSON.stringify({
    kind: "community",
    mode: "ranked",
    scope: "all",
    metrics: { kd: { avg: 2 } },
    savedAt: now,
    fetchedAt: new Date(now + 1).toISOString(),
  }));
  assert.equal(readCommunityCache(communityStorage, "ranked", "all", now), null);
});

test("community cache is independent by mode and requested match scope", () => {
  const storage = new MemoryStorage();
  const now = 4_000_000;
  assert.equal(writeCommunityCache(storage, "ranked", "all", {
    metrics: {
      kills: {
        avg: 4,
        percentile1: 0,
        percentile5: 1,
        percentile10: 2,
        percentile25: 3,
        percentile50: 4,
        percentile75: 5,
        percentile90: 6,
        percentile95: 7,
        percentile99: 8,
        std: 99,
      },
    },
  }, now), true);
  assert.equal(writeCommunityCache(storage, "ranked", "50", { metrics: { kills: { avg: 3 } } }, now), true);
  assert.equal(writeCommunityCache(storage, "standard", "all", { metrics: { kills: { avg: 2 } } }, now), true);

  const raw = JSON.parse(storage.getItem("deadlock-stats-community:v3:ranked:all"));
  assert.deepEqual(raw.metrics.kills, {
    avg: 4,
    percentile1: 0,
    percentile5: 1,
    percentile10: 2,
    percentile25: 3,
    percentile50: 4,
    percentile75: 5,
    percentile90: 6,
    percentile95: 7,
    percentile99: 8,
  });
  assert.equal(readCommunityCache(storage, "ranked", "all", now).value.metrics.kills.avg, 4);
  assert.equal(readCommunityCache(storage, "ranked", "all", now).value.metrics.kills.percentile99, 8);
  assert.equal(readCommunityCache(storage, "ranked", "50", now).value.metrics.kills.avg, 3);
  assert.equal(readCommunityCache(storage, "standard", "all", now).value.metrics.kills.avg, 2);
  storage.setItem("deadlock-stats-community:v1:ranked:all", JSON.stringify({
    kind: "community",
    mode: "ranked",
    scope: "all",
    metrics: { kills: { avg: 1 } },
    savedAt: now,
  }));
  assert.equal(readCommunityCache(storage, "standard", "50", now), null);
  assert.equal(writeCommunityCache(storage, "ranked", "recent", { metrics: { kills: { avg: 1 } } }, now), false);
});

test("serialized storage bounds evict the oldest entries before a write", () => {
  const storage = new MemoryStorage();
  const now = 4_500_000;
  const padding = "x".repeat(Math.ceil(MAX_CACHE_SERIALIZED_BYTES / 3));
  const oldKeys = [1, 2, 3].map((accountId) => `deadlock-stats-player:v2:${accountId}:ranked`);
  oldKeys.forEach((key, index) => {
    storage.setItem(key, JSON.stringify({
      kind: "player",
      accountId: index + 1,
      mode: "ranked",
      maxMatches: 25,
      savedAt: now,
      lastUsedAt: now + index,
      payload: padding,
    }));
  });

  const newKey = "deadlock-stats-player:v2:999:ranked";
  assert.equal(writePlayerCache(storage, 999, "ranked", playerValue(now, 25, 999), now), true);
  assert.equal(storage.getItem(oldKeys[0]), null);
  assert.notEqual(storage.getItem(oldKeys[1]), null);
  assert.notEqual(storage.getItem(oldKeys[2]), null);
  assert.notEqual(storage.getItem(newKey), null);
  assert.equal(storage.length, 3);
});

test("quota failure evicts oldest valid entries and retries once within the bound", () => {
  const storage = new QuotaStorage();
  const now = 5_000_000;
  for (let account = 1; account <= MAX_CACHE_ENTRIES; account += 1) {
    assert.equal(
      writePlayerCache(storage, account, "ranked", playerValue(now + account, 25, account), now + account),
      true,
    );
  }
  storage.failNext = true;
  assert.equal(
    writePlayerCache(storage, 999, "ranked", playerValue(now + 1000, 25, 999), now + 1000),
    true,
  );
  assert.equal(storage.getItem("deadlock-stats-player:v2:1:ranked"), null);
  assert.equal(storage.getItem("deadlock-stats-player:v2:2:ranked"), null);
  assert.notEqual(storage.getItem("deadlock-stats-player:v2:999:ranked"), null);
  assert.equal(storage.length, MAX_CACHE_ENTRIES - 1);
});

test("legacy namespaces are purged and bounded writes clean expired entries", () => {
  const storage = new MemoryStorage();
  const now = 6_000_000;
  const legacyKeys = [
    "deadlock-stats-cache:v2:old",
    "deadlock-stats-cache:v3:old",
    "deadlock-stats-bridge-cache:v1:old",
    "deadlock-stats-compat:v1:old",
    "deadlock-stats-bridge:v2:old",
    "deadlock-stats-community:v1:old",
    "deadlock-stats-player:v1:old",
    "deadlock-stats-community:v2:old",
  ];
  for (const key of legacyKeys) storage.setItem(key, "x");
  storage.setItem("unrelated-storage", "keep");
  assert.equal(purgeLegacyNamespaces(storage), legacyKeys.length);
  for (const key of legacyKeys) assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem("unrelated-storage"), "keep");

  storage.setItem("deadlock-stats-player:v1:50:ranked", JSON.stringify({
    kind: "player",
    savedAt: now - STALE_TTL_MS,
    accountId: 50,
    mode: "ranked",
    maxMatches: 25,
    samples: playerValue(now, 25).samples,
  }));
  storage.setItem("deadlock-stats-player:v1:51:ranked", JSON.stringify({
    kind: "player",
    savedAt: now + 1,
    accountId: 51,
    mode: "ranked",
    maxMatches: 25,
    samples: playerValue(now, 25, 51).samples,
  }));
  storage.setItem("deadlock-stats-rate:v1:malformed", "{not-json");

  assert.equal(
    writeCommunityCache(storage, "standard", "all", { metrics: { kills: { avg: 2 } } }, now),
    true,
  );
  assert.equal(storage.getItem("deadlock-stats-player:v1:50:ranked"), null);
  assert.equal(storage.getItem("deadlock-stats-player:v1:51:ranked"), null);
  assert.equal(storage.getItem("deadlock-stats-rate:v1:malformed"), null);
  assert.notEqual(storage.getItem("deadlock-stats-community:v3:standard:all"), null);
});

test("rate headers persist cooldown state and expose remaining reset time", () => {
  const storage = new MemoryStorage();
  const now = 7_000_000;
  const state = updateRateState(
    storage,
    "metadata",
    {
      "RateLimit-Limit": "10",
      "RateLimit-Period": "60",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "30",
    },
    { now, status: 200 },
  );
  assert.equal(state.blockedUntil, now + 30_000);
  assert.equal(state.limit, 10);
  assert.equal(state.period, 60);
  assert.equal(state.remaining, 0);
  assert.equal(readRateState(storage, "metadata", now + 1).blockedUntil, now + 30_000);
  assert.equal(rateCooldownRemaining(storage, "metadata", now + 1), 29_999);
  assert.equal(rateCooldownRemaining(storage, "metadata", now + 30_001), 0);

  const limited = updateRateState(
    storage,
    "community",
    { "Retry-After": "17", "RateLimit-Reset": "3" },
    { now, status: 429 },
  );
  assert.equal(limited.blockedUntil, now + 17_000);
  assert.equal(rateCooldownRemaining(storage, "community", now), 17_000);
});

test("headerless 429 responses persist a conservative cooldown", () => {
  const storage = new MemoryStorage();
  const now = 2_000_000;
  const state = updateRateState(storage, "metadata", {}, { now, status: 429 });
  assert.equal(state.blockedUntil, now + 60_000);
  assert.equal(rateCooldownRemaining(storage, "metadata", now), 60_000);
});

test("Web Locks serialize ownership and let the second caller reuse cache", async () => {
  const tails = new Map();
  const navigatorRef = {
    locks: {
      request(name, options, callback) {
        if (typeof options === "function") callback = options;
        const previous = tails.get(name) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
          release = resolve;
        });
        tails.set(name, current);
        return previous.then(async () => {
          try {
            return await callback();
          } finally {
            release();
            if (tails.get(name) === current) tails.delete(name);
          }
        });
      },
    },
  };
  const storage = new MemoryStorage();
  let cachedValue = null;
  let fetches = 0;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  let releaseNetwork;
  const networkGate = new Promise((resolve) => {
    releaseNetwork = resolve;
  });
  const produce = async () => {
    if (cachedValue) return { source: "cache", value: cachedValue };
    fetches += 1;
    firstStartedResolve();
    await networkGate;
    cachedValue = { sampleSize: 1 };
    return { source: "network", value: cachedValue };
  };

  const first = withResourceOwnership({
    resourceKey: "player:123:ranked",
    storage,
    navigatorRef,
    run: produce,
  });
  const second = withResourceOwnership({
    resourceKey: "player:123:ranked",
    storage,
    navigatorRef,
    run: produce,
  });
  await firstStarted;
  assert.equal(fetches, 1);
  releaseNetwork();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.owned, true);
  assert.equal(firstResult.value.source, "network");
  assert.equal(secondResult.owned, true);
  assert.equal(secondResult.value.source, "cache");
  assert.equal(fetches, 1);
});

test("storage ownership times out while another lease remains active", async () => {
  const storage = new MemoryStorage();
  const ownerKey = "deadlock-stats-owner:v1:busy";
  storage.setItem(ownerKey, JSON.stringify({ owner: "other", expiresAt: 1_000 }));
  let ticks = 0;
  let runs = 0;

  const result = await withResourceOwnership({
    resourceKey: "busy",
    storage,
    navigatorRef: null,
    now: () => 200 + ticks++,
    leaseMs: 50,
    timeoutMs: 4,
    waitMs: 1,
    run: async () => {
      runs += 1;
      return "unexpected";
    },
  });

  assert.equal(result.owned, false);
  assert.equal(result.value, null);
  assert.equal(runs, 0);
  assert.notEqual(storage.getItem(ownerKey), null);
});

test("storage ownership stops waiting when its caller aborts", async () => {
  const storage = new MemoryStorage();
  storage.setItem("deadlock-stats-owner:v1:busy-abort", JSON.stringify({
    owner: "other",
    expiresAt: 1_000,
  }));
  const controller = new AbortController();
  let runs = 0;
  const pending = withResourceOwnership({
    resourceKey: "busy-abort",
    storage,
    navigatorRef: null,
    signal: controller.signal,
    now: () => 200,
    leaseMs: 50,
    timeoutMs: 1_000,
    waitMs: 20,
    run: async () => {
      runs += 1;
    },
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(runs, 0);
});

test("expired storage lease is reclaimed by the next owner", async () => {
  const storage = new MemoryStorage();
  storage.setItem("deadlock-stats-owner:v1:resource", JSON.stringify({
    owner: "abandoned",
    expiresAt: 100,
  }));
  let runs = 0;

  const result = await withResourceOwnership({
    resourceKey: "resource",
    storage,
    navigatorRef: null,
    now: () => 200,
    leaseMs: 50,
    timeoutMs: 100,
    waitMs: 1,
    run: async () => {
      runs += 1;
      return "recovered";
    },
  });

  assert.equal(result.owned, true);
  assert.equal(result.value, "recovered");
  assert.equal(runs, 1);
  assert.equal(storage.getItem("deadlock-stats-owner:v1:resource"), null);
});

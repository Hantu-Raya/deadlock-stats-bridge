import test from "node:test";
import assert from "node:assert/strict";

import { updateRateState as persistRateState } from "../src/cache.js";
import { ApiError } from "../src/api.js";
import {
  CONTROLS_STORAGE_KEY,
  createExplorerApp,
  normalizeAccountId,
  parseQueryState,
} from "../src/app.js";

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }
}

function metadataResponse(fetchedAt = "2026-08-25T00:00:00.000Z", data = []) {
  return {
    url: "https://api.example.test/metadata",
    status: 200,
    headers: {},
    data,
    fetchedAt,
  };
}

function communityResponse(fetchedAt = "2026-08-25T00:00:00.000Z", data = { metrics: { kd: { avg: 2 } } }) {
  return {
    url: "https://api.example.test/community",
    status: 200,
    headers: {},
    data,
    fetchedAt,
  };
}

function cached(value, freshness = "fresh", ageMs = 0) {
  return { value, freshness, ageMs };
}

function sampleAnalysis(accountId) {
  return { sampleSize: 1, accountId, metrics: [], supplemental: {} };
}

function playerCacheValue(accountId = 50, mode = "ranked", fetchedAt = "2026-08-25T00:00:00.000Z") {
  const sample = sampleAnalysis(accountId);
  return {
    accountId,
    mode,
    maxMatches: 200,
    fetchedAt,
    samples: Object.fromEntries([25, 50, 100, 200].map((limit) => [String(limit), sample])),
  };
}

function communityCacheValue(mode = "ranked", scope = "all", fetchedAt = "2026-08-25T00:00:00.000Z") {
  return {
    mode,
    scope,
    fetchedAt,
    metrics: { kd: { avg: 2 } },
  };
}

function createUi(accountId = "", limit = 50, mode = "ranked") {
  const ui = {
    controls: { accountId, limit, mode },
    renders: [],
    errors: [],
    loading: [],
    onLookup: null,
    onRefresh: null,
    bindExplorerControls({ onLookup, onRefresh } = {}) {
      ui.onLookup = onLookup;
      ui.onRefresh = onRefresh;
    },
    readControls() {
      return { ...ui.controls };
    },
    writeControls(next = {}) {
      if (next.accountId !== undefined && next.accountId !== null) {
        ui.controls.accountId = String(next.accountId);
      }
      if (next.limit !== undefined && next.limit !== null) {
        ui.controls.limit = Number(next.limit);
      }
      if (next.mode !== undefined && next.mode !== null) {
        ui.controls.mode = String(next.mode);
      }
    },
    setLoading(value) {
      ui.loading.push(Boolean(value));
    },
    renderExplorer(model) {
      ui.renders.push(model);
    },
    renderError(model) {
      ui.errors.push(model);
    },
    renderEmpty() {},
  };
  return ui;
}

function createHarness({
  accountId = "50",
  limit = 50,
  mode = "ranked",
  location = new URL("https://example.test/explorer"),
  storage: suppliedStorage = null,
  initialPlayerCache = null,
  initialCommunityCache = null,
  fetchMetadata = async () => metadataResponse(),
  fetchCommunity = async () => communityResponse(),
  readPlayerCache,
  writePlayerCache,
  readCommunityCache,
  writeCommunityCache,
  readRateState,
  updateRateState,
  own,
} = {}) {
  const storage = suppliedStorage ?? new MemoryStorage();
  const ui = createUi(accountId, limit, mode);
  const history = {
    state: null,
    lastUrl: null,
    replaceState(state, _title, url) {
      this.state = state;
      this.lastUrl = url;
    },
  };
  const resourceKey = (id, resourceMode) => `${id}:${resourceMode}`;
  const communityKey = (resourceMode, scope) => `${resourceMode}:${scope}`;
  const playerEntries = new Map();
  const communityEntries = new Map();
  if (initialPlayerCache) {
    playerEntries.set(resourceKey(Number(accountId), mode), initialPlayerCache);
  }
  if (initialCommunityCache) {
    communityEntries.set(communityKey(mode, "all"), initialCommunityCache);
  }
  const playerWrites = [];
  const communityWrites = [];
  let now = 2_000_000;
  const app = createExplorerApp({
    ui,
    storage,
    location,
    history,
    now: () => now,
    clearCache() {},
    fetchMetadata,
    fetchCommunity,
    readPlayerCache: readPlayerCache ?? ((_storage, id, resourceMode) => playerEntries.get(resourceKey(id, resourceMode)) ?? null),
    writePlayerCache: writePlayerCache ?? ((_storage, id, resourceMode, value) => {
      playerWrites.push({ id, mode: resourceMode, value });
      playerEntries.set(resourceKey(id, resourceMode), cached(value));
      return true;
    }),
    readCommunityCache: readCommunityCache ?? ((_storage, resourceMode, scope) => communityEntries.get(communityKey(resourceMode, scope)) ?? null),
    writeCommunityCache: writeCommunityCache ?? ((_storage, resourceMode, scope, value) => {
      communityWrites.push({ mode: resourceMode, scope, value });
      communityEntries.set(communityKey(resourceMode, scope), cached(value));
      return true;
    }),
    ...(readRateState ? { readRateState } : {}),
    ...(updateRateState ? { updateRateState } : {}),
    ...(own ? { own } : {}),
  });

  return {
    app,
    playerEntries,
    communityEntries,
    history,
    location,
    now: (value) => {
      now = value;
    },
    storage,
    ui,
    playerWrites,
    communityWrites,
  };
}

test("normalizes safe account IDs and share query state", () => {
  assert.equal(normalizeAccountId("00050"), 50);
  assert.equal(normalizeAccountId(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeAccountId(String(Number.MAX_SAFE_INTEGER + 1)), null);
  assert.equal(normalizeAccountId("1e3"), null);
  assert.deepEqual(parseQueryState("?account_id=50&matches=100"), {
    accountId: 50,
    limit: 100,
    mode: "ranked",
    hasAccountId: true,
  });
  assert.deepEqual(parseQueryState("?account_id=bad&matches=999"), {
    accountId: null,
    limit: 50,
    mode: "ranked",
    hasAccountId: false,
  });
});

test("loads a valid share URL from fresh resource caches without a request", async () => {
  let metadataCalls = 0;
  let communityCalls = 0;
  const harness = createHarness({
    accountId: "50",
    initialPlayerCache: cached(playerCacheValue(50), "fresh", 1000),
    initialCommunityCache: cached(communityCacheValue(), "fresh", 1000),
    limit: 25,
    location: new URL("https://example.test/explorer?account_id=50&matches=25"),
    fetchMetadata: async () => {
      metadataCalls += 1;
      return metadataResponse();
    },
    fetchCommunity: async () => {
      communityCalls += 1;
      return communityResponse();
    },
  });

  harness.app.start();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(metadataCalls, 0);
  assert.equal(communityCalls, 0);
  assert.equal(harness.ui.renders.at(-1).source, "cache");
  assert.equal(harness.ui.renders.at(-1).accountId, 50);
  assert.equal(harness.ui.renders.at(-1).limit, 25);
  assert.equal(harness.ui.controls.accountId, "50");
  assert.equal(harness.ui.controls.limit, 25);
});

test("explicit refresh bypasses fresh player cache and synchronizes local and URL state", async () => {
  let metadataCalls = 0;
  let communityCalls = 0;
  const harness = createHarness({
    initialPlayerCache: cached(playerCacheValue(), "fresh", 1000),
    initialCommunityCache: cached(communityCacheValue(), "fresh", 1000),
    fetchMetadata: async () => {
      metadataCalls += 1;
      return metadataResponse("2026-08-25T00:01:00.000Z");
    },
    fetchCommunity: async () => {
      communityCalls += 1;
      return communityResponse();
    },
    own: async ({ run }) => ({ owned: true, value: await run() }),
  });
  harness.app.start();

  const cachedResult = await harness.app.lookup();
  assert.equal(cachedResult.source, "cache");
  assert.equal(metadataCalls, 0);
  assert.equal(communityCalls, 0);

  const refreshedResult = await harness.app.refresh();
  assert.equal(refreshedResult.source, "network");
  assert.equal(metadataCalls, 1);
  assert.equal(communityCalls, 0);
  assert.deepEqual(JSON.parse(harness.storage.getItem(CONTROLS_STORAGE_KEY)), {
    accountId: 50,
    limit: 50,
    mode: "ranked",
  });
  assert.equal(harness.history.lastUrl, "/explorer?account_id=50&matches=50");
});

test("marks preserved player cache stale after a failed explicit refresh", async () => {
  const harness = createHarness({
    initialPlayerCache: cached(playerCacheValue(), "fresh", 1000),
    fetchMetadata: async () => {
      throw new ApiError("Deadlock API request failed (503)", {
        status: 503,
        retryAfter: "30",
        url: "https://api.example.test/metadata",
        detail: "temporarily unavailable",
      });
    },
    own: async ({ run }) => ({ owned: true, value: await run() }),
  });
  harness.app.start();
  await harness.app.lookup();

  const result = await harness.app.refresh();

  assert.equal(result.ok, false);
  assert.equal(harness.ui.renders.at(-1).source, "stale");
  assert.equal(harness.ui.errors.at(-1).stale, true);
  assert.equal(harness.ui.errors.at(-1).preserveData, true);
  assert.equal(harness.ui.errors.at(-1).status, 503);
  assert.equal(harness.ui.errors.at(-1).retryAfter, "30");
});
test("retains stale player output and surfaces API status and Retry-After", async () => {
  const harness = createHarness({
    initialPlayerCache: cached(playerCacheValue(), "stale", 11 * 60 * 1000),
    fetchMetadata: async () => {
      throw new ApiError("Deadlock API request failed (429)", {
        status: 429,
        retryAfter: "17",
        url: "https://api.example.test/metadata",
        detail: "slow down",
      });
    },
    own: async ({ run }) => ({ owned: true, value: await run() }),
  });
  harness.app.start();

  const result = await harness.app.lookup();

  assert.equal(result.ok, false);
  assert.equal(harness.ui.renders.at(-1).source, "stale");
  assert.equal(harness.ui.errors.length, 1);
  assert.equal(harness.ui.errors[0].stale, true);
  assert.equal(harness.ui.errors[0].preserveData, true);
  assert.equal(harness.ui.errors[0].status, 429);
  assert.equal(harness.ui.errors[0].retryAfter, "17");
  assert.match(harness.ui.errors[0].message, /slow down/);
});

test("deduplicates same-key requests and aborts superseded work", async () => {
  const pending = [];
  const harness = createHarness({
    accountId: "50",
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: ({ accountId, signal }) => new Promise((resolve, reject) => {
      const request = { accountId, resolve, reject, signal };
      pending.push(request);
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    fetchCommunity: async () => communityResponse(),
  });
  harness.app.start();

  const first = harness.app.lookup();
  const duplicate = harness.app.lookup();
  await Promise.resolve();

  harness.ui.controls.accountId = "51";
  const superseding = harness.app.lookup();
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);

  pending[1].resolve(metadataResponse("2026-08-25T00:02:00.000Z"));
  const [firstResult, duplicateResult, supersedingResult] = await Promise.all([
    first,
    duplicate,
    superseding,
  ]);

  assert.equal(firstResult.aborted, true);
  assert.equal(duplicateResult.aborted, true);
  assert.equal(supersedingResult.source, "network");
  assert.equal(harness.ui.renders.at(-1).accountId, 51);
  assert.deepEqual(harness.playerWrites.map(({ id }) => id), [51]);
});

test("cancelled ownership is not reused by an immediate retry", async () => {
  let ownershipCalls = 0;
  const harness = createHarness({
    initialCommunityCache: cached(communityCacheValue(), "fresh", 1_000),
    own: ({ signal, run }) => {
      ownershipCalls += 1;
      if (ownershipCalls > 1) {
        return Promise.resolve(run()).then((value) => ({ owned: true, value }));
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
    fetchMetadata: async () => metadataResponse("2026-08-25T00:02:30.000Z"),
  });
  harness.app.start();

  const cancelled = harness.app.lookup();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.app.cancel(), true);
  const retried = harness.app.lookup();
  const [cancelledResult, retriedResult] = await Promise.all([cancelled, retried]);

  assert.equal(cancelledResult.aborted, true);
  assert.equal(retriedResult.ok, true);
  assert.equal(ownershipCalls, 2);
});

test("does not request without a valid account ID", async () => {
  let calls = 0;
  const harness = createHarness({
    accountId: "0",
    fetchMetadata: async () => {
      calls += 1;
      return metadataResponse();
    },
  });
  harness.app.start();

  const result = await harness.app.lookup();

  assert.equal(result.reason, "invalid-account-id");
  assert.equal(calls, 0);
  assert.equal(harness.ui.errors.at(-1).kind, "validation");
});
test("smaller explorer counts use one 200-match player metadata fetch", async () => {
  for (const limit of [25, 50, 100, 200]) {
    const requests = [];
    const harness = createHarness({
      limit,
      own: async ({ run }) => ({ owned: true, value: await run() }),
      fetchMetadata: async (request) => {
        requests.push(request);
        return metadataResponse();
      },
      fetchCommunity: async () => communityResponse(),
    });
    harness.app.start();

    const result = await harness.app.lookup();

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].accountId, 50);
    assert.equal(requests[0].limit, 200);
    assert.equal(requests[0].matches, undefined);
    assert.equal(requests[0].metricsLimit, undefined);
  }
});

test("same-page count changes share one player promise", async () => {
  const pending = [];
  const harness = createHarness({
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: ({ signal }) => new Promise((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    }),
    fetchCommunity: async () => communityResponse(),
  });
  harness.app.start();

  const first = harness.app.lookup();
  await Promise.resolve();
  harness.ui.controls.limit = 100;
  const second = harness.app.lookup();
  await Promise.resolve();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signal.aborted, false);

  pending[0].resolve(metadataResponse("2026-08-25T00:03:00.000Z"));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.aborted, true);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.model.limit, 100);
});


test("same-account count changes reuse cached player prefixes", async () => {
  const metadataRequests = [];
  const communityRequests = [];
  const harness = createHarness({
    limit: 25,
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async (request) => {
      metadataRequests.push(request);
      return metadataResponse();
    },
    fetchCommunity: async (request) => {
      communityRequests.push(request);
      return communityResponse();
    },
  });
  harness.app.start();

  const first = await harness.app.lookup();
  harness.ui.controls.limit = 100;
  const second = await harness.app.lookup();

  assert.equal(first.source, "network");
  assert.equal(second.source, "cache");
  assert.equal(second.model.limit, 100);
  assert.equal(metadataRequests.length, 1);
  assert.equal(communityRequests.length, 1);
  assert.equal(harness.playerWrites.length, 1);
  assert.equal(harness.communityWrites.length, 1);
});

test("network raw responses stay memory-only and are released on account changes", async () => {
  const metadataData = { matches: [{ match_id: 1 }] };
  const communityData = { metrics: { kd: { avg: 2 } } };
  const harness = createHarness({
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async () => metadataResponse("2026-08-25T00:04:00.000Z", metadataData),
    fetchCommunity: async () => communityResponse("2026-08-25T00:04:00.000Z", communityData),
  });
  harness.app.start();

  const first = await harness.app.lookup();
  const firstResponses = first.model.responses;
  assert.equal(firstResponses.metadata.rawRetained, true);
  assert.strictEqual(firstResponses.metadata.data, metadataData);
  assert.equal(firstResponses.community.rawRetained, true);
  assert.strictEqual(firstResponses.community.data, communityData);

  harness.ui.controls.accountId = "51";
  await harness.app.lookup();

  assert.equal(firstResponses.metadata.rawRetained, false);
  assert.equal(firstResponses.community.rawRetained, false);
  assert.equal(Object.prototype.hasOwnProperty.call(firstResponses.metadata, "data"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(firstResponses.community, "data"), false);
});
test("account changes reuse the ranked all-community cache", async () => {
  const metadataRequests = [];
  const communityRequests = [];
  const harness = createHarness({
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async (request) => {
      metadataRequests.push(request);
      return metadataResponse();
    },
    fetchCommunity: async (request) => {
      communityRequests.push(request);
      return communityResponse();
    },
  });
  harness.app.start();

  assert.equal((await harness.app.lookup()).ok, true);
  harness.ui.controls.accountId = "51";
  assert.equal((await harness.app.lookup()).ok, true);

  assert.deepEqual(metadataRequests.map(({ accountId, mode }) => ({ accountId, mode })), [
    { accountId: 50, mode: "ranked" },
    { accountId: 51, mode: "ranked" },
  ]);
  assert.deepEqual(communityRequests.map(({ mode, metricsLimit }) => ({ mode, metricsLimit })), [
    { mode: "ranked", metricsLimit: null },
  ]);
  assert.deepEqual(harness.communityWrites.map(({ mode, scope }) => ({ mode, scope })), [
    { mode: "ranked", scope: "all" },
  ]);
});

test("player and community resources stay separate by mode", async () => {
  const metadataModes = [];
  const communityModes = [];
  const harness = createHarness({
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async ({ mode }) => {
      metadataModes.push(mode);
      return metadataResponse();
    },
    fetchCommunity: async ({ mode }) => {
      communityModes.push(mode);
      return communityResponse();
    },
  });
  harness.app.start();

  assert.equal((await harness.app.lookup()).ok, true);
  harness.ui.controls.mode = "standard";
  assert.equal((await harness.app.lookup()).ok, true);

  assert.deepEqual(metadataModes, ["ranked", "standard"]);
  assert.deepEqual(communityModes, ["ranked", "standard"]);
  assert.deepEqual(harness.playerWrites.map(({ mode }) => mode), ["ranked", "standard"]);
  assert.deepEqual(harness.communityWrites.map(({ mode, scope }) => ({ mode, scope })), [
    { mode: "ranked", scope: "all" },
    { mode: "standard", scope: "all" },
  ]);
});

test("refresh bypasses only the player resource and requests no-cache", async () => {
  const metadataRequests = [];
  let communityFetches = 0;
  const harness = createHarness({
    initialPlayerCache: cached(playerCacheValue(), "fresh", 1),
    initialCommunityCache: cached(communityCacheValue(), "fresh", 1),
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async (request) => {
      metadataRequests.push(request);
      return metadataResponse();
    },
    fetchCommunity: async () => {
      communityFetches += 1;
      return communityResponse();
    },
  });
  harness.app.start();
  assert.equal((await harness.app.lookup()).source, "cache");

  const refreshed = await harness.app.refresh();

  assert.equal(refreshed.ok, true);
  assert.equal(metadataRequests.length, 1);
  assert.equal(metadataRequests[0].cache, "no-cache");
  assert.equal(communityFetches, 0);
});

test("community success is persisted when metadata fails", async () => {
  const harness = createHarness({
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async () => {
      throw new ApiError("metadata unavailable", { status: 503, detail: "metadata failed" });
    },
    fetchCommunity: async () => communityResponse(),
  });
  harness.app.start();

  const result = await harness.app.lookup();

  assert.equal(result.ok, false);
  assert.deepEqual(harness.communityWrites.map(({ mode, scope }) => ({ mode, scope })), [
    { mode: "ranked", scope: "all" },
  ]);
});

test("persisted cooldowns prevent all resource fetches", async () => {
  const storage = new MemoryStorage();
  const now = 2_000_000;
  persistRateState(storage, "metadata", { "Retry-After": "30" }, { now, status: 429 });
  persistRateState(storage, "community", { "Retry-After": "30" }, { now, status: 429 });
  let metadataFetches = 0;
  let communityFetches = 0;
  const harness = createHarness({
    storage,
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchMetadata: async () => {
      metadataFetches += 1;
      return metadataResponse();
    },
    fetchCommunity: async () => {
      communityFetches += 1;
      return communityResponse();
    },
  });
  harness.app.start();

  const result = await harness.app.lookup();

  assert.equal(result.ok, false);
  assert.equal(metadataFetches, 0);
  assert.equal(communityFetches, 0);
});
test("stale community data is used after a network 429", async () => {
  const harness = createHarness({
    initialPlayerCache: cached(playerCacheValue(), "fresh", 1),
    initialCommunityCache: cached(communityCacheValue(), "stale", 11 * 60 * 1000),
    own: async ({ run }) => ({ owned: true, value: await run() }),
    fetchCommunity: async () => {
      throw new ApiError("community rate limited", { status: 429, retryAfter: "12" });
    },
  });
  harness.app.start();

  const result = await harness.app.lookup();

  assert.equal(result.ok, false);
  assert.equal(harness.ui.renders.at(-1).source, "stale");
  assert.equal(harness.ui.errors.at(-1).status, 429);
  assert.equal(harness.ui.errors.at(-1).stale, true);
});

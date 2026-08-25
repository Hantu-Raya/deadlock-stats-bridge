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

function response() {
  return {
    fetchedAt: "2026-08-25T00:00:00.000Z",
    metadata: [],
    community: {},
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

test("fresh same-account 50 cache is used without a network request", async () => {
  const location = { search: "?account_id=123&matches=50&mode=ranked&request=req_01" };
  const documentRef = titleDocument();
  const storage = new MemoryStorage();
  let fetches = 0;
  const result = await runBridge({
    location,
    documentRef,
    storage,
    now: () => 10_000,
    readCache: (_storage, account, matches, mode, now) => {
      assert.equal(account, 123);
      assert.equal(matches, 50);
      assert.equal(mode, "ranked");
      assert.equal(now, 10_000);
      return {
        freshness: "fresh",
        ageMs: 100,
        value: {
          fetchedAt: "2026-08-25T00:00:00.000Z",
          analysis: analysis(),
        },
      };
    },
    apiFetch: async () => {
      fetches += 1;
      return response();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "cache");
  assert.equal(fetches, 0);
  assert.equal(parseBridgeTitle(documentRef.writes[0]).ok, true);
  assert.equal(documentRef.title, result.title);
  assert.equal(location.hash, encodeURIComponent(result.title));
});

test("malformed fresh cache falls through to a clean network result", async () => {
  const documentRef = titleDocument();
  let fetches = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_bad_cache" },
    documentRef,
    now: () => 10_000,
    readCache: () => ({
      freshness: "fresh",
      ageMs: 1,
      value: { fetchedAt: "2026-08-25T00:00:00.000Z", analysis: { sampleSize: 1 } },
    }),
    apiFetch: async () => {
      fetches += 1;
      return response();
    },
    analyze: () => analysis(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "network");
  assert.equal(fetches, 1);
});

test("aborted bridge requests publish no title", async () => {
  const documentRef = titleDocument();
  const controller = new AbortController();
  controller.abort();
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_abort" },
    documentRef,
    signal: controller.signal,
    apiFetch: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  assert.deepEqual(result, { ok: false, aborted: true });
  assert.deepEqual(documentRef.writes, []);
});

test("already-aborted cache hits publish no title", async () => {
  const documentRef = titleDocument();
  const controller = new AbortController();
  controller.abort();
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_abort_cache" },
    documentRef,
    signal: controller.signal,
    readCache: () => ({
      freshness: "fresh",
      ageMs: 1,
      value: {
        fetchedAt: "2026-08-25T00:00:00.000Z",
        analysis: analysis(),
      },
    }),
    apiFetch: async () => {
      throw new Error("network must stay idle");
    },
  });

  assert.deepEqual(result, { ok: false, aborted: true });
  assert.deepEqual(documentRef.writes, []);
});

test("abort during analysis prevents cache and title writes", async () => {
  const documentRef = titleDocument();
  const controller = new AbortController();
  let cacheWrites = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=50&mode=ranked&request=req_abort_analysis" },
    documentRef,
    signal: controller.signal,
    readCache: () => null,
    apiFetch: async () => response(),
    analyze: () => {
      controller.abort();
      return analysis();
    },
    writeCache: () => {
      cacheWrites += 1;
    },
  });

  assert.deepEqual(result, { ok: false, aborted: true });
  assert.equal(cacheWrites, 0);
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

test("stale cache is not used and network result is cached", async () => {
  const documentRef = titleDocument();
  const storage = new MemoryStorage();
  let fetches = 0;
  let writes = 0;
  const result = await runBridge({
    location: { search: "?account_id=123&matches=100&mode=standard&request=req_02" },
    documentRef,
    storage,
    now: () => 10_000,
    readCache: () => ({ freshness: "stale", ageMs: 700_000, value: { analysis: analysis() } }),
    apiFetch: async ({ accountId, limit, mode }) => {
      fetches += 1;
      assert.deepEqual({ accountId, limit, mode }, {
        accountId: 123,
        limit: 100,
        mode: "standard",
      });
      return response();
    },
    analyze: () => analysis(),
    writeCache: (_storage, account, matches, mode, value) => {
      writes += 1;
      assert.deepEqual({ account, matches, mode }, {
        account: 123,
        matches: 100,
        mode: "standard",
      });
      assert.equal(value.analysis.sampleSize, 3);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "network");
  assert.equal(writes, 1);
});

test("API failures emit an allowlisted error without raw detail", async () => {
  const location = { search: "?account_id=123&matches=150&mode=standard&request=req_03" };
  const documentRef = titleDocument();
  const result = await runBridge({
    location,
    documentRef,
    apiFetch: async () => {
      throw new ApiError("request failed", {
        status: 429,
        retryAfter: "5",
        detail: "secret response body",
      });
    },
  });
  const parsed = parseBridgeTitle(result.title);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload, {
    v: 2,
    kind: "error",
    request: "req_03",
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

test("publishTitle persists the encoded title", () => {
  const documentRef = titleDocument();
  const locationRef = {};
  const title = "DLSTATS2:{\"v\":2}";
  const didAssign = publishTitle(title, { documentRef, locationRef });

  assert.equal(didAssign, true);
  assert.equal(documentRef.title, title);
  assert.equal(locationRef.hash, encodeURIComponent(title));
});

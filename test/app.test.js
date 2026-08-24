import test from "node:test";
import assert from "node:assert/strict";

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

function response(fetchedAt = "2026-08-25T00:00:00.000Z") {
  return {
    fetchedAt,
    metadata: {
      url: "https://api.example.test/metadata",
      status: 200,
      headers: {},
      data: [],
    },
    community: {
      url: "https://api.example.test/community",
      status: 200,
      headers: {},
      data: {},
    },
  };
}

function analysis(accountId) {
  return { sampleSize: 1, accountId, metrics: [], supplemental: {} };
}

function cached(value, freshness = "fresh", ageMs = 0) {
  return { value, freshness, ageMs };
}

function cacheValue(accountId = 50, fetchedAt = "2026-08-25T00:00:00.000Z") {
  const responses = response(fetchedAt);
  return {
    responses,
    analysis: analysis(accountId),
    fetchedAt,
  };
}

function createUi(accountId = "", limit = 50) {
  const ui = {
    controls: { accountId, limit },
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
  location = new URL("https://example.test/explorer"),
  initialCache = null,
  apiFetch = async () => response(),
  analyze = ({ accountId: id }) => analysis(id),
} = {}) {
  const storage = new MemoryStorage();
  const ui = createUi(accountId, limit);
  const history = {
    state: null,
    lastUrl: null,
    replaceState(state, _title, url) {
      this.state = state;
      this.lastUrl = url;
    },
  };
  const entries = new Map();
  const keyFor = (id, sample) => `${id}:${sample}`;
  if (initialCache) {
    entries.set(keyFor(accountId, limit), initialCache);
  }
  const writes = [];
  let now = 2_000_000;
  const app = createExplorerApp({
    ui,
    storage,
    location,
    history,
    now: () => now,
    clearCache() {},
    readCache(_storage, id, sample) {
      return entries.get(keyFor(id, sample)) ?? null;
    },
    writeCache(_storage, id, sample, value) {
      writes.push({ id, sample, value });
      entries.set(keyFor(id, sample), cached(value));
    },
    apiFetch,
    analyze,
  });

  return {
    app,
    entries,
    history,
    location,
    now: (value) => {
      now = value;
    },
    storage,
    ui,
    writes,
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
    hasAccountId: true,
  });
  assert.deepEqual(parseQueryState("?account_id=bad&matches=999"), {
    accountId: null,
    limit: 50,
    hasAccountId: false,
  });
});

test("loads a valid share URL from fresh cache without a request", () => {
  let calls = 0;
  const harness = createHarness({
    accountId: "50",
    initialCache: cached(cacheValue(50), "fresh", 1000),
    limit: 25,
    location: new URL("https://example.test/explorer?account_id=50&matches=25"),
    apiFetch: async () => {
      calls += 1;
      return response();
    },
  });

  harness.app.start();

  assert.equal(calls, 0);
  assert.equal(harness.ui.renders.at(-1).source, "cache");
  assert.equal(harness.ui.renders.at(-1).accountId, 50);
  assert.equal(harness.ui.renders.at(-1).limit, 25);
  assert.equal(harness.ui.controls.accountId, "50");
  assert.equal(harness.ui.controls.limit, 25);
});

test("explicit refresh bypasses fresh cache and synchronizes local and URL state", async () => {
  let calls = 0;
  const harness = createHarness({
    initialCache: cached(cacheValue(), "fresh", 1000),
    apiFetch: async () => {
      calls += 1;
      return response("2026-08-25T00:01:00.000Z");
    },
  });
  harness.app.start();

  const cachedResult = await harness.app.lookup();
  assert.equal(cachedResult.source, "cache");
  assert.equal(calls, 0);

  const refreshedResult = await harness.app.refresh();
  assert.equal(refreshedResult.source, "network");
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(harness.storage.getItem(CONTROLS_STORAGE_KEY)), {
    accountId: 50,
    limit: 50,
  });
  assert.equal(harness.history.lastUrl, "/explorer?account_id=50&matches=50");
});

test("marks preserved cache stale after a failed explicit refresh", async () => {
  const harness = createHarness({
    initialCache: cached(cacheValue(), "fresh", 1000),
    apiFetch: async () => {
      throw new ApiError("Deadlock API request failed (503)", {
        status: 503,
        retryAfter: "30",
        url: "https://api.example.test/metadata",
        detail: "temporarily unavailable",
      });
    },
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

test("retains stale output and surfaces API status and Retry-After", async () => {
  const staleValue = cacheValue();
  const harness = createHarness({
    initialCache: cached(staleValue, "stale", 11 * 60 * 1000),
    apiFetch: async () => {
      throw new ApiError("Deadlock API request failed (429)", {
        status: 429,
        retryAfter: "17",
        url: "https://api.example.test/metadata",
        detail: "slow down",
      });
    },
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
    apiFetch: ({ accountId, signal }) => new Promise((resolve, reject) => {
      const request = { accountId, resolve, reject, signal };
      pending.push(request);
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  harness.app.start();

  const first = harness.app.lookup();
  const duplicate = harness.app.lookup();
  assert.equal(pending.length, 1);

  harness.ui.controls.accountId = "51";
  const superseding = harness.app.lookup();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);

  pending[1].resolve(response("2026-08-25T00:02:00.000Z"));
  const [firstResult, duplicateResult, supersedingResult] = await Promise.all([
    first,
    duplicate,
    superseding,
  ]);

  assert.equal(firstResult.aborted, true);
  assert.equal(duplicateResult.aborted, true);
  assert.equal(supersedingResult.source, "network");
  assert.equal(harness.ui.renders.at(-1).accountId, 51);
});

test("does not request without a valid account ID", async () => {
  let calls = 0;
  const harness = createHarness({
    accountId: "0",
    apiFetch: async () => {
      calls += 1;
      return response();
    },
  });
  harness.app.start();

  const result = await harness.app.lookup();

  assert.equal(result.reason, "invalid-account-id");
  assert.equal(calls, 0);
  assert.equal(harness.ui.errors.at(-1).kind, "validation");
});

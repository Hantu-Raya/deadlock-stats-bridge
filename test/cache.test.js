import test from "node:test";
import assert from "node:assert/strict";

import {
  FRESH_TTL_MS,
  STALE_TTL_MS,
  clearExpiredResults,
  readCachedResult,
  writeCachedResult,
} from "../src/cache.js";

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }
}

function put(storage, key, savedAt, value = { ok: true }) {
  storage.setItem(key, JSON.stringify({ savedAt, value }));
}

test("readCachedResult has deterministic fresh/stale/expired boundaries", () => {
  const storage = new MemoryStorage();
  const now = 2_000_000;
  const key = "deadlock-stats-cache:v2:50:25";

  put(storage, key, now);
  assert.deepEqual(readCachedResult(storage, 50, 25, now), {
    value: { ok: true },
    ageMs: 0,
    freshness: "fresh",
  });

  put(storage, key, now - FRESH_TTL_MS + 1);
  assert.equal(readCachedResult(storage, 50, 25, now).freshness, "fresh");

  put(storage, key, now - FRESH_TTL_MS);
  assert.equal(readCachedResult(storage, 50, 25, now).freshness, "stale");

  put(storage, key, now - STALE_TTL_MS + 1);
  assert.equal(readCachedResult(storage, 50, 25, now).freshness, "stale");

  put(storage, key, now - STALE_TTL_MS);
  assert.equal(readCachedResult(storage, 50, 25, now), null);
});

test("writeCachedResult serializes generic values and read returns them", () => {
  const storage = new MemoryStorage();
  const originalNow = Date.now;
  Date.now = () => 4_000_000;
  try {
    assert.equal(writeCachedResult(storage, 99, 100, { response: [1, 2], analysis: null }), true);
  } finally {
    Date.now = originalNow;
  }

  const cached = readCachedResult(storage, 99, 100, 4_000_000 + 1);
  assert.deepEqual(cached.value, { response: [1, 2], analysis: null });
  assert.equal(cached.ageMs, 1);
});
 
test("writeCachedResult treats unavailable storage as a cache miss", () => {
  const storage = {
    setItem() {
      throw new Error("quota exceeded");
    },
  };
  assert.equal(writeCachedResult(storage, 50, 25, { response: [] }), false);
});

test("clearExpiredResults removes only malformed or expired cache entries", () => {
  const storage = new MemoryStorage();
  const now = 8_000_000;
  put(storage, "deadlock-stats-cache:v2:50:25", now - STALE_TTL_MS - 1);
  put(storage, "deadlock-stats-cache:v2:50:50", now - 1);
  storage.setItem("deadlock-stats-cache:v2:bad", "not-json");
  storage.setItem("other-app-key", "keep");

  assert.equal(clearExpiredResults(storage, now), 2);
  assert.equal(storage.getItem("deadlock-stats-cache:v2:50:25"), null);
  assert.equal(storage.getItem("deadlock-stats-cache:v2:bad"), null);
  assert.notEqual(storage.getItem("deadlock-stats-cache:v2:50:50"), null);
  assert.equal(storage.getItem("other-app-key"), "keep");
});

test("v1 cache entries are ignored by the comparison cache namespace", () => {
  const storage = new MemoryStorage();
  const now = 9_000_000;
  put(storage, "deadlock-stats-cache:v1:50:25", now, { old: true });

  assert.equal(readCachedResult(storage, 50, 25, now), null);
  assert.equal(writeCachedResult(storage, 50, 25, { old: false }), true);
  assert.notEqual(storage.getItem("deadlock-stats-cache:v2:50:25"), null);
});

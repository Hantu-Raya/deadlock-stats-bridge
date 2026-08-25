import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  MAX_RESPONSE_BYTES,
  buildMetadataUrl,
  buildMetricsUrl,
  fetchCommunity,
  fetchMetadata,
  fetchEnvelope,
} from "../src/api.js";

test("buildMetadataUrl requests direct player columns for each supported sample", () => {
  for (const limit of [25, 50, 100, 200]) {
    for (const [mode, apiMode] of [["ranked", "ranked"], ["standard", "unranked"]]) {
      const url = new URL(buildMetadataUrl(7654321, limit, mode));
      assert.equal(url.origin, "https://api.deadlock-api.com");
      assert.equal(url.pathname, "/v1/matches/metadata");
      assert.equal(url.searchParams.get("match_mode"), apiMode);
      assert.equal(url.searchParams.get("account_ids"), "7654321");
      assert.equal(url.searchParams.get("limit"), String(limit));
      assert.equal(url.searchParams.get("order_by"), "start_time");
      assert.equal(url.searchParams.get("order_direction"), "desc");
      assert.equal(url.searchParams.get("include_info"), "false");
      assert.equal(url.searchParams.get("extra_match_columns"), "duration_s");
      assert.equal(url.searchParams.get("include_player_kda"), "true");
      assert.equal(url.searchParams.get("include_player_final_stats"), "true");
      assert.equal(url.searchParams.get("extra_player_columns"), "mvp_rank");
      assert.equal(url.searchParams.get("format"), "json");
    }
  }
});

test("buildMetricsUrl maps mode and selected match count", () => {
  for (const limit of [25, 50, 100, 200]) {
    for (const [mode, apiMode] of [["ranked", "ranked"], ["standard", "unranked"]]) {
      const url = new URL(buildMetricsUrl(limit, mode));
      assert.equal(url.origin, "https://api.deadlock-api.com");
      assert.equal(url.pathname, "/v1/analytics/player-stats/metrics");
      assert.equal(url.searchParams.get("match_mode"), apiMode);
      assert.equal(url.searchParams.get("max_matches"), String(limit));
    }
  }
});

test("buildMetricsUrl preserves the unbounded default", () => {
  const ranked = new URL(buildMetricsUrl());
  assert.equal(ranked.searchParams.get("match_mode"), "ranked");
  assert.equal(ranked.searchParams.get("max_matches"), null);

  const standard = new URL(buildMetricsUrl(undefined, "standard"));
  assert.equal(standard.searchParams.get("match_mode"), "unranked");
  assert.equal(standard.searchParams.get("max_matches"), null);
});

test("API builders reject unsupported modes", () => {
  assert.throws(() => buildMetadataUrl(7654321, 50, "casual"), /mode/);
  assert.throws(() => buildMetricsUrl(50, "casual"), /mode/);
});

test("fetchMetadata and fetchCommunity return response envelopes", async () => {
  const calls = [];
  const controller = new AbortController();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const isMetadata = url.includes("/v1/matches/metadata");
    return {
      ok: true,
      status: 200,
      headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "9" },
      async text() {
        return JSON.stringify(isMetadata ? [{ match_id: 1 }] : { kills: { avg: 4 } });
      },
    };
  };

  const metadata = await fetchMetadata({
    accountId: 50,
    limit: 100,
    mode: "standard",
    signal: controller.signal,
    fetchImpl,
    cache: "no-cache",
  });
  const community = await fetchCommunity({
    mode: "standard",
    metricsLimit: 100,
    signal: controller.signal,
    fetchImpl,
    cache: "no-cache",
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.signal && call.options.signal !== controller.signal));
  assert.ok(calls.every((call) => call.options.signal.aborted === false));
  assert.ok(calls.every((call) => call.options.cache === "no-cache"));
  assert.equal(new URL(calls[0].url).searchParams.get("match_mode"), "unranked");
  assert.equal(new URL(calls[1].url).searchParams.get("match_mode"), "unranked");
  assert.equal(new URL(calls[1].url).searchParams.get("max_matches"), "100");
  assert.deepEqual(metadata.headers, {
    "content-type": "application/json",
    "x-ratelimit-remaining": "9",
  });
  assert.deepEqual(metadata.data, [{ match_id: 1 }]);
  assert.deepEqual(community.data, { kills: { avg: 4 } });
  assert.equal(metadata.status, 200);
  assert.equal(community.status, 200);
  assert.doesNotThrow(() => JSON.stringify({ metadata, community }));
});

test("fetchMetadata preserves status, Retry-After, URL, and safe error detail", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    headers: { "Retry-After": "17" },
    async text() {
      return JSON.stringify({ message: "slow down", token: "must-not-leak" });
    },
  });

  await assert.rejects(
    fetchMetadata({ accountId: 50, limit: 25, fetchImpl }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, "17");
      assert.match(error.url, /\/v1\/matches\/metadata/);
      assert.equal(error.detail, "slow down");
      assert.equal("must-not-leak".includes(error.detail), false);
      return true;
    },
  );
});

test("fetchMetadata wraps response-body failures as ApiError", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    headers: { "Retry-After": "3" },
    async text() {
      throw new Error("body stream closed");
    },
  });

  await assert.rejects(
    fetchMetadata({ accountId: 50, limit: 25, fetchImpl }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.retryAfter, "3");
      assert.match(error.url, /\/v1\/matches\/metadata/);
      assert.equal(error.detail, "body stream closed");
      return true;
    },
  );
});

test("fetchCommunity rejects oversized responses before reading the body", async () => {
  let bodyRead = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
    async text() {
      bodyRead = true;
      return "{}";
    },
  });

  await assert.rejects(
    fetchCommunity({ mode: "ranked", fetchImpl }),
    (error) => error instanceof ApiError && error.code === "payload_too_large",
  );
  assert.equal(bodyRead, false);
});

test("fetchMetadata cancels a chunked body that crosses the byte limit", async () => {
  let cancelled = 0;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: {},
    body: {
      getReader() {
        return {
          async read() {
            return { done: false, value: { byteLength: MAX_RESPONSE_BYTES + 1 } };
          },
          async cancel() {
            cancelled += 1;
          },
          releaseLock() {},
        };
      },
    },
  });

  await assert.rejects(
    fetchMetadata({ accountId: 50, limit: 50, fetchImpl }),
    (error) => error instanceof ApiError && error.code === "payload_too_large",
  );
  assert.ok(cancelled >= 1);
});

test("metadata failure does not prevent an independent community success", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/v1/matches/metadata")) {
      return {
        ok: false,
        status: 503,
        headers: {},
        async text() {
          return "{\"message\":\"down\"}";
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {},
      async text() {
        return "{\"kills\":{\"avg\":4}}";
      },
    };
  };

  const [metadata, community] = await Promise.allSettled([
    fetchMetadata({ accountId: 50, limit: 50, fetchImpl }),
    fetchCommunity({ mode: "ranked", fetchImpl }),
  ]);

  assert.equal(metadata.status, "rejected");
  assert.ok(metadata.reason instanceof ApiError);
  assert.equal(metadata.reason.status, 503);
  assert.equal(community.status, "fulfilled");
  assert.deepEqual(community.value.data, { kills: { avg: 4 } });
});

test("direct fetch functions reject an already-aborted signal before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, headers: {}, async text() { return "[]"; } };
  };

  await assert.rejects(
    fetchMetadata({ accountId: 50, limit: 50, signal: controller.signal, fetchImpl }),
    (error) => error?.name === "AbortError",
  );
  await assert.rejects(
    fetchCommunity({ mode: "ranked", signal: controller.signal, fetchImpl }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(calls, 0);
});

test("fetchEnvelope times out even when the fetch implementation ignores its signal", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    fetchEnvelope("https://api.example.test/hang", () => new Promise(() => {}), undefined, {
      timeoutMs: 5,
    }),
    (error) => error instanceof ApiError && error.code === "timeout",
  );
  assert.ok(Date.now() - startedAt < 250);
});

test("fetchEnvelope remains bounded when AbortController is unavailable", async () => {
  const previous = globalThis.AbortController;
  globalThis.AbortController = undefined;
  try {
    const result = await fetchEnvelope(
      "https://api.example.test/ok",
      async (_url, options) => ({
        ok: true,
        status: 200,
        headers: {},
        async text() {
          assert.equal(Object.prototype.hasOwnProperty.call(options, "signal"), false);
          return "{}";
        },
      }),
      undefined,
      { timeoutMs: 50 },
    );
    assert.deepEqual(result.data, {});
  } finally {
    globalThis.AbortController = previous;
  }
});

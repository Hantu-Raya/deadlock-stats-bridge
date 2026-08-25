import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  MAX_RESPONSE_BYTES,
  buildMetadataUrl,
  buildMetricsUrl,
  fetchDeadlockData,
} from "../src/api.js";

test("buildMetadataUrl maps every bridge dataset to the API mode", () => {
  for (const matches of [50, 100, 150]) {
    for (const [mode, apiMode] of [["ranked", "ranked"], ["standard", "unranked"]]) {
      const url = new URL(buildMetadataUrl(7654321, matches, mode));
      assert.equal(url.pathname, "/v1/matches/metadata");
      assert.equal(url.searchParams.get("match_mode"), apiMode);
      assert.equal(url.searchParams.get("account_ids"), "7654321");
      assert.equal(url.searchParams.get("limit"), String(matches));
      assert.equal(url.searchParams.get("order_by"), "start_time");
      assert.equal(url.searchParams.get("order_direction"), "desc");
      assert.equal(url.searchParams.get("include_info"), "true");
      assert.equal(url.searchParams.get("include_player_kda"), "true");
      assert.equal(url.searchParams.get("include_player_final_stats"), "true");
      assert.equal(url.searchParams.get("extra_player_columns"), "mvp_rank");
      assert.equal(url.searchParams.get("format"), "json");
    }
  }
});

test("buildMetricsUrl maps mode and selected match count", () => {
  for (const matches of [50, 100, 150]) {
    for (const [mode, apiMode] of [["ranked", "ranked"], ["standard", "unranked"]]) {
      const url = new URL(buildMetricsUrl(matches, mode));
      assert.equal(url.pathname, "/v1/analytics/player-stats/metrics");
      assert.equal(url.searchParams.get("match_mode"), apiMode);
      assert.equal(url.searchParams.get("max_matches"), String(matches));
    }
  }
});

test("buildMetricsUrl preserves the app's unbounded default", () => {
  const url = new URL(buildMetricsUrl());
  assert.equal(url.searchParams.get("match_mode"), "ranked");
  assert.equal(url.searchParams.get("max_matches"), null);
});

test("API builders reject unsupported modes", () => {
  assert.throws(() => buildMetadataUrl(7654321, 50, "casual"), /mode/);
  assert.throws(() => buildMetricsUrl(50, "casual"), /mode/);
});

test("fetchDeadlockData returns serializable response envelopes", async () => {
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

  const result = await fetchDeadlockData({
    accountId: 50,
    limit: 100,
    mode: "standard",
    metricsLimit: 100,
    signal: controller.signal,
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.signal && call.options.signal.aborted === false));
  assert.equal(new URL(calls[0].url).searchParams.get("match_mode"), "unranked");
  assert.equal(new URL(calls[1].url).searchParams.get("match_mode"), "unranked");
  assert.equal(new URL(calls[1].url).searchParams.get("max_matches"), "100");
  assert.deepEqual(result.metadata.headers, {
    "content-type": "application/json",
    "x-ratelimit-remaining": "9",
  });
  assert.deepEqual(result.metadata.data, [{ match_id: 1 }]);
  assert.deepEqual(result.community.data, { kills: { avg: 4 } });
  assert.equal(typeof result.fetchedAt, "string");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("fetchDeadlockData preserves status, Retry-After, URL, and safe detail", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/v1/matches/metadata")) {
      return {
        ok: false,
        status: 429,
        headers: { "Retry-After": "17" },
        async text() {
          return JSON.stringify({ message: "slow down", token: "must-not-leak" });
        },
      };
    }
    return { ok: true, status: 200, headers: {}, async text() { return "{}"; } };
  };

  await assert.rejects(
    fetchDeadlockData({ accountId: 50, limit: 25, fetchImpl }),
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
 
test("fetchDeadlockData wraps response-body failures as ApiError", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/v1/matches/metadata")) {
      return {
        ok: false,
        status: 503,
        headers: { "Retry-After": "3" },
        async text() {
          throw new Error("body stream closed");
        },
      };
    }
    return { ok: true, status: 200, headers: {}, async text() { return "{}"; } };
  };

  await assert.rejects(
    fetchDeadlockData({ accountId: 50, limit: 25, fetchImpl }),
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

test("fetchDeadlockData rejects oversized responses before reading the body", async () => {
  let bodyRead = false;
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
    async text() {
      bodyRead = true;
      return url.includes("/metadata") ? "[]" : "{}";
    },
  });

  await assert.rejects(
    fetchDeadlockData({ accountId: 50, limit: 50, fetchImpl }),
    (error) => error instanceof ApiError && error.code === "payload_too_large",
  );
  assert.equal(bodyRead, false);
});

test("fetchDeadlockData cancels a chunked body that crosses the byte limit", async () => {
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
    fetchDeadlockData({ accountId: 50, limit: 50, fetchImpl }),
    (error) => error instanceof ApiError && error.code === "payload_too_large",
  );
  assert.ok(cancelled >= 1);
});

test("fetchDeadlockData aborts the sibling request after one endpoint fails", async () => {
  let siblingAborted = false;
  const fetchImpl = async (url, { signal }) => {
    if (url.includes("/v1/matches/metadata")) {
      return {
        ok: false,
        status: 503,
        headers: {},
        async text() { return "{\"message\":\"down\"}"; },
      };
    }
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        siblingAborted = true;
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };

  await assert.rejects(
    fetchDeadlockData({ accountId: 50, limit: 50, fetchImpl }),
    (error) => error instanceof ApiError && error.status === 503,
  );
  assert.equal(siblingAborted, true);
});

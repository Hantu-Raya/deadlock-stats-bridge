import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  buildMetadataUrl,
  buildMetricsUrl,
  fetchDeadlockData,
} from "../src/api.js";

test("buildMetadataUrl encodes the ranked target-player request", () => {
  const url = new URL(buildMetadataUrl(7654321, 50));
  assert.equal(url.pathname, "/v1/matches/metadata");
  assert.equal(url.searchParams.get("match_mode"), "ranked");
  assert.equal(url.searchParams.get("account_ids"), "7654321");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("order_by"), "start_time");
  assert.equal(url.searchParams.get("order_direction"), "desc");
  assert.equal(url.searchParams.get("include_info"), "true");
  assert.equal(url.searchParams.get("include_player_kda"), "true");
  assert.equal(url.searchParams.get("include_player_final_stats"), "true");
  assert.equal(url.searchParams.get("extra_player_columns"), "mvp_rank");
  assert.equal(url.searchParams.get("format"), "json");
});

test("buildMetricsUrl targets ranked community metrics", () => {
  const url = new URL(buildMetricsUrl());
  assert.equal(url.pathname, "/v1/analytics/player-stats/metrics");
  assert.equal(url.searchParams.get("match_mode"), "ranked");
});

test("fetchDeadlockData returns serializable response envelopes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const isMetadata = url.includes("/v1/matches/metadata");
    return {
      ok: true,
      status: 200,
      headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "9" },
      async json() {
        return isMetadata ? [{ match_id: 1 }] : { kills: { avg: 4 } };
      },
    };
  };

  const result = await fetchDeadlockData({ accountId: 50, limit: 25, signal: "signal", fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal, "signal");
  assert.equal(result.metadata.status, 200);
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
        async json() {
          return { message: "slow down", token: "must-not-leak" };
        },
      };
    }
    return { ok: true, status: 200, headers: {}, async json() { return {}; } };
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
        async json() {
          throw new Error("body stream closed");
        },
        async text() {
          throw new Error("body stream closed");
        },
      };
    }
    return { ok: true, status: 200, headers: {}, async json() { return {}; } };
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

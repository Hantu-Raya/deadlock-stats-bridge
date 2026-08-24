import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_MATCHES,
  TITLE_MAX_LENGTH,
  TITLE_PREFIX,
  buildErrorPayload,
  buildErrorTitle,
  buildSuccessPayload,
  buildSuccessTitle,
  parseBridgeQuery,
  parseBridgeTitle,
  selectMetricGroups,
} from "../src/title-protocol.js";

const METRIC_IDS = [
  "kd",
  "kda",
  "average-kills",
  "average-assists",
  "average-deaths",
  "damage-taken-per-minute",
  "player-damage-per-minute",
  "accuracy",
  "critical-hit-rate",
  "net-worth-per-minute",
  "boss-damage-per-minute",
  "healing-per-minute",
];

function analysis(values = {}) {
  return {
    sampleSize: 7,
    metrics: METRIC_IDS.map((id) => ({
      id,
      value: values[id]?.player ?? 1.234,
      communityValue: values[id]?.community ?? 9.876,
    })),
  };
}

test("bridge query requires account_id, matches=50, and a bounded ASCII nonce", () => {
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&request=req_01").ok, true);
  assert.equal(parseBridgeQuery("?account_id=0&matches=50&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=25&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&request=bad%20nonce").ok, false);
  assert.equal(parseBridgeQuery(`?account_id=123&matches=50&request=${"a".repeat(65)}`).ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&request=req_01&request=req_02").ok, false);
});

test("success payload keeps the six groups and static metric order", () => {
  const payload = buildSuccessPayload({
    request: "req_01",
    account: 123,
    matches: BRIDGE_MATCHES,
    sample: 7,
    generated: "2026-08-25T00:00:00.000Z",
    analysis: analysis(),
  });

  assert.deepEqual(payload.groups.map((group) => group.id), [
    "combat",
    "kills",
    "survival",
    "damage",
    "economy",
    "sustain",
  ]);
  assert.deepEqual(payload.groups.flatMap((group) => group.metrics.map((metric) => metric.id)), [
    "kd",
    "kda",
    "average_kills",
    "average_assists",
    "average_deaths",
    "damage_taken_per_minute",
    "player_damage_per_minute",
    "accuracy",
    "critical_hit_rate",
    "net_worth_per_minute",
    "boss_damage_per_minute",
    "healing_per_minute",
  ]);
});

test("metric values round to two decimals and invalid values become null", () => {
  const groups = selectMetricGroups(analysis({
    kd: { player: 1.235, community: Number.NaN },
    kda: { player: Number.POSITIVE_INFINITY, community: Number.NaN },
  }));
  assert.deepEqual(groups[0].metrics, [
    { id: "kd", player: 1.24, community: null },
    { id: "kda", player: null, community: null },
  ]);
});

test("titles use the compact prefix and stay within the 2048-code-unit cap", () => {
  const title = buildSuccessTitle({
    request: "a".repeat(64),
    account: 123,
    matches: BRIDGE_MATCHES,
    sample: 50,
    generated: "x".repeat(64),
    analysis: analysis(Object.fromEntries(METRIC_IDS.map((id) => [
      id,
      { player: Number.MAX_VALUE, community: Number.MIN_VALUE },
    ]))),
  });
  assert.equal(title.startsWith(TITLE_PREFIX), true);
  assert.ok(title.length <= TITLE_MAX_LENGTH);
  assert.equal(parseBridgeTitle(title).ok, true);
});

test("error payloads keep identity fields, allowlisted code, and optional safe details", () => {
  const payload = buildErrorPayload({
    request: "req_01",
    account: 123,
    matches: BRIDGE_MATCHES,
    code: "rate_limit",
    status: 429,
    retry_after: 8,
    message: "Try again shortly.",
  });
  assert.deepEqual(payload, {
    v: 1,
    kind: "error",
    request: "req_01",
    account: 123,
    matches: 50,
    code: "rate_limit",
    status: 429,
    retry_after: 8,
    message: "Try again shortly.",
  });
  assert.throws(() => buildErrorTitle({ code: "raw_api_body" }), /allowlisted/);
  assert.equal(parseBridgeTitle(buildErrorTitle(payload)).ok, true);
});

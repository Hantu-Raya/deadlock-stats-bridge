import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_MATCHES,
  ALLOWED_MODES,
  DEFAULT_MATCHES,
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
test("bridge query requires exactly one valid account, count, mode, and nonce", () => {
  for (const matches of ALLOWED_MATCHES) {
    for (const mode of ALLOWED_MODES) {
      const parsed = parseBridgeQuery(
        `?account_id=123&matches=${matches}&mode=${mode}&request=req_01`,
      );
      assert.deepEqual(parsed, {
        ok: true,
        account: 123,
        matches,
        mode,
        request: "req_01",
      });
    }
  }

  assert.equal(parseBridgeQuery("?account_id=0&matches=50&mode=ranked&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=25&mode=ranked&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&mode=casual&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&mode=ranked").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&mode=ranked&request=req_01&mode=standard").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&mode=ranked&request=req_01&request=req_02").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=050&mode=ranked&request=req_01").ok, false);
  assert.equal(parseBridgeQuery("?account_id=123&matches=50&mode=ranked&request=bad%20nonce").ok, false);
  assert.equal(parseBridgeQuery(`?account_id=123&matches=50&mode=ranked&request=${"a".repeat(65)}`).ok, false);
});

test("success payload keeps the six groups and static metric order", () => {
  const payload = buildSuccessPayload({
    request: "req_01",
    account: 123,
    matches: DEFAULT_MATCHES,
    mode: "ranked",
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

test("success and error builders accept each supported count and mode", () => {
  for (const matches of ALLOWED_MATCHES) {
    for (const mode of ALLOWED_MODES) {
      const payload = buildSuccessPayload({
        request: "req_01",
        account: 123,
        matches,
        mode,
        sample: matches,
        generated: "2026-08-25T00:00:00.000Z",
        analysis: analysis(),
      });
      assert.equal(payload.matches, matches);
      assert.equal(payload.mode, mode);
      assert.equal(parseBridgeTitle(buildSuccessTitle({
        request: "req_01",
        account: 123,
        matches,
        mode,
        sample: matches,
        generated: "2026-08-25T00:00:00.000Z",
        analysis: analysis(),
      })).ok, true);

      const error = buildErrorPayload({
        request: "req_01",
        account: 123,
        matches,
        mode,
        code: "invalid_payload",
      });
      assert.equal(error.matches, matches);
      assert.equal(error.mode, mode);
    }
  }
});

test("payload builders reject unsupported counts and modes", () => {
  assert.throws(() => buildSuccessPayload({
    request: "req_01",
    account: 123,
    matches: 25,
    mode: "ranked",
    sample: 1,
    generated: "generated",
    analysis: analysis(),
  }), /matches/);
  assert.throws(() => buildSuccessPayload({
    request: "req_01",
    account: 123,
    matches: 50,
    mode: "casual",
    sample: 1,
    generated: "generated",
    analysis: analysis(),
  }), /mode/);
  assert.throws(() => buildErrorPayload({
    request: "req_01",
    account: 123,
    matches: 200,
    mode: "ranked",
    code: "invalid_payload",
  }), /matches/);
  assert.throws(() => buildErrorPayload({
    request: "req_01",
    account: 123,
    matches: 50,
    mode: "casual",
    code: "invalid_payload",
  }), /mode/);
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
    matches: DEFAULT_MATCHES,
    mode: "ranked",
    sample: DEFAULT_MATCHES,
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

test("error payloads keep identity fields, mode, allowlisted code, and optional safe details", () => {
  const payload = buildErrorPayload({
    request: "req_01",
    account: 123,
    matches: DEFAULT_MATCHES,
    mode: "standard",
    code: "rate_limit",
    status: 429,
    retry_after: 8,
    message: "Try again shortly.",
  });
  assert.deepEqual(payload, {
    v: 2,
    kind: "error",
    request: "req_01",
    account: 123,
    matches: DEFAULT_MATCHES,
    mode: "standard",
    code: "rate_limit",
    status: 429,
    retry_after: 8,
    message: "Try again shortly.",
  });
  assert.throws(() => buildErrorTitle({ code: "raw_api_body" }), /allowlisted/);
  assert.equal(parseBridgeTitle(buildErrorTitle(payload)).ok, true);
});

test("title parsing rejects malformed success identity and error modes", () => {
  const success = buildSuccessPayload({
    request: "req_01",
    account: 123,
    matches: 50,
    mode: "ranked",
    sample: 10,
    generated: "2026-08-25T00:00:00.000Z",
    analysis: analysis(),
  });
  for (const payload of [
    { ...success, request: "" },
    { ...success, account: 0 },
    { ...success, account: null },
  ]) {
    assert.equal(
      parseBridgeTitle(TITLE_PREFIX + JSON.stringify(payload)).ok,
      false,
    );
  }

  const error = buildErrorPayload({
    request: "req_01",
    account: 123,
    matches: 50,
    mode: "ranked",
    code: "invalid_payload",
  });
  assert.equal(
    parseBridgeTitle(TITLE_PREFIX + JSON.stringify({ ...error, mode: "casual" })).ok,
    false,
  );
});

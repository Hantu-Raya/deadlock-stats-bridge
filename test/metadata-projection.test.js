import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildMetadataUrl, fetchMetadata, normalizeMetadataProjection } from "../src/api.js";
import { ANALYSIS_METRIC_IDS, aggregatePlayerPrefixes } from "../src/metrics.js";

const ACCOUNT_ID = 487348881;
const LIMITS = [1, 2, 3, 4];
const MODES = [["ranked", "ranked"], ["standard", "unranked"]];

// Trimmed live responses for ACCOUNT_ID: `full` is the legacy include_player_final_stats
// shape (final_stats cut to the keys metrics.js reads), `projected` is the new query's shape.
function fixture(kind, fileMode) {
  return JSON.parse(readFileSync(new URL(`./fixtures/metadata-${kind}-${fileMode}.json`, import.meta.url), "utf8"));
}

function aggregate(metadata) {
  return aggregatePlayerPrefixes({ accountId: ACCOUNT_ID, metadata, limits: LIMITS });
}

test("metadata query projects the stats it needs instead of requesting final stats", () => {
  const url = new URL(buildMetadataUrl(ACCOUNT_ID, 150, "ranked"));
  assert.equal(url.searchParams.get("include_player_final_stats"), null);
  assert.equal(url.searchParams.get("include_player_kda"), "true");
  assert.equal(url.searchParams.get("include_info"), "false");
  assert.equal(url.searchParams.get("extra_match_columns"), "duration_s");
  // Teammates must stay in the response: kill participation divides by all same-team kills.
  assert.equal(url.searchParams.get("only_filtered_players"), null);
  const columns = url.searchParams.get("extra_player_columns").split(",");
  for (const column of ["last_hits", "denies", "mvp_rank", "stats.net_worth", "stats.player_damage", "stats.hero_bullets_hit_crit"]) {
    assert.ok(columns.includes(column), column);
  }
  assert.equal(new Set(columns).size, columns.length);
  // The scalar net_worth column differs from the final-stats value and skews net worth/min.
  assert.ok(!columns.includes("net_worth"));
});

test("projected fixtures are a small fraction of the full response and keep every teammate", () => {
  for (const [, fileMode] of MODES) {
    const full = fixture("full", fileMode);
    const projected = fixture("projected", fileMode);
    assert.equal(projected.length, full.length);
    projected.forEach((match, index) => {
      assert.equal(match.match_id, full[index].match_id);
      assert.equal(match.players.length, full[index].players.length);
      assert.ok(match.players.length > 1);
      assert.ok(match.players.every((player) => player.final_stats === undefined && typeof player.kills === "number"));
    });
  }
});

test("projected metadata yields identical metrics for every prefix and mode", () => {
  for (const [, fileMode] of MODES) {
    const expected = aggregate(fixture("full", fileMode));
    const actual = aggregate(normalizeMetadataProjection(fixture("projected", fileMode)));
    assert.equal(expected.maxMatches, 4);
    assert.deepEqual(Object.keys(actual.samples), LIMITS.map(String));
    assert.deepEqual(actual, expected);
    for (const sample of Object.values(actual.samples)) {
      assert.deepEqual(sample.metrics.map((metric) => metric.id), ANALYSIS_METRIC_IDS);
      assert.ok(sample.metrics.every((metric) => metric.value !== null), "no metric silently loses its input");
      assert.ok(sample.supplemental.averageMvp.value !== null);
      assert.ok(sample.supplemental.killParticipation.value !== null);
    }
  }
});

test("kill participation still sees every teammate's kills", () => {
  const projected = normalizeMetadataProjection(fixture("projected", "ranked"));
  const baseline = aggregate(projected).samples["4"].supplemental.killParticipation.value;
  // Drop the teammates: the denominator shrinks to the player's own kills and the value must change.
  const alone = structuredClone(projected);
  for (const match of alone) match.players = match.players.filter((player) => player.account_id === ACCOUNT_ID);
  assert.notEqual(aggregate(alone).samples["4"].supplemental.killParticipation.value, baseline);
  assert.deepEqual(aggregate(fixture("full", "ranked")).samples["4"].supplemental.killParticipation, aggregate(projected).samples["4"].supplemental.killParticipation);
});

test("fetchMetadata returns projected rows in the shape metrics.js reads", async () => {
  const calls = [];
  const raw = fixture("projected", "unranked");
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: {},
      async text() {
        return JSON.stringify(raw);
      },
    };
  };
  const envelope = await fetchMetadata({ accountId: ACCOUNT_ID, limit: 4, mode: "standard", fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get("include_player_final_stats"), null);
  assert.ok(envelope.data.every((match) => match.players.every((player) => player.stats && !Object.keys(player).some((key) => key.startsWith("stats_")))));
  assert.deepEqual(aggregate(envelope.data), aggregate(fixture("full", "unranked")));
});

test("normalizeMetadataProjection leaves legacy and malformed payloads alone", () => {
  const legacy = fixture("full", "ranked");
  const before = JSON.stringify(legacy);
  assert.equal(normalizeMetadataProjection(legacy), legacy);
  assert.equal(JSON.stringify(legacy), before);
  for (const value of [null, undefined, "text", 7, {}, [], [null, { players: null }, { players: [null, 5, "x"] }]]) {
    assert.doesNotThrow(() => normalizeMetadataProjection(value));
  }
  const wrapped = { data: [{ players: [{ account_id: 1, stats_kills: [1, 2] }] }] };
  normalizeMetadataProjection(wrapped);
  assert.deepEqual(wrapped.data[0].players[0], { account_id: 1, stats: { kills: [1, 2] } });
});

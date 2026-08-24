import test from "node:test";
import assert from "node:assert/strict";

import { analyzePlayer } from "../src/metrics.js";

function metric(analysis, id) {
  return analysis.metrics.find((entry) => entry.id === id);
}

const community = {
  data: {
    kills: { avg: 7.25 },
    deaths: { avg: 6.5 },
    assists: { avg: 13.25 },
    kd: { avg: 3.5 },
    kda: { avg: 4.75 },
    net_worth_per_min: { avg: 1000 },
    player_damage_per_min: { avg: 900 },
    player_damage_taken_per_min: { avg: 800 },
    accuracy: { avg: 0.52 },
    crit_shot_rate: { avg: 0.14 },
    boss_damage_per_min: { avg: 200 },
    healing_per_min: { avg: 300 },
  },
};

const metadata = {
  data: [
    {
      match_id: 1,
      duration_s: 600,
      players: [
        {
          account_id: 7,
          team: 0,
          kills: 10,
          deaths: 2,
          assists: 4,
          net_worth: 600,
          mvp_rank: 2,
          final_stats: {
            max_player_damage: 3000,
            max_player_damage_taken: 1000,
            max_boss_damage: 50,
            max_self_healing: 100,
            max_player_healing: 200,
            max_shots_hit: 50,
            max_shots_missed: 50,
            max_hero_bullets_hit_crit: 10,
            max_hero_bullets_hit: 90,
          },
        },
        { account_id: 8, team: 0, kills: 5, deaths: 4, assists: 1 },
        { account_id: 9, team: 1, kills: 12, deaths: 3, assists: 2 },
      ],
    },
    {
      match_id: 2,
      duration_s: 1200,
      players: [
        {
          account_id: "7",
          team: 0,
          kills: 4,
          deaths: 4,
          assists: 2,
          net_worth: 600,
          mvp_rank: 4,
          final_stats: {
            max_player_damage: 2000,
            max_player_damage_taken: 2000,
            max_boss_damage: 100,
            max_self_healing: 0,
            max_player_healing: 200,
            max_shots_hit: 80,
            max_shots_missed: 20,
            max_hero_bullets_hit_crit: 20,
            max_hero_bullets_hit: 80,
          },
        },
        { account_id: 10, team: 0, kills: 6, deaths: 5, assists: 2 },
      ],
    },
  ],
};

test("analyzePlayer compares player values with exact community averages", () => {
  const analysis = analyzePlayer({ accountId: 7, metadata, community });
  assert.equal(analysis.sampleSize, 2);
  assert.equal(analysis.totalDurationSeconds, 1800);

  const kd = metric(analysis, "kd");
  assert.deepEqual(Object.keys(kd).sort(), [
    "communityDisplayValue",
    "communityValue",
    "displayValue",
    "id",
    "label",
    "unit",
    "value",
  ].sort());
  assert.equal(kd.value, 3);
  assert.equal(kd.displayValue, "3.00");
  assert.equal(kd.communityValue, 3.5);
  assert.equal(kd.communityDisplayValue, "3.50");

  assert.equal(metric(analysis, "kda").value, 4.25);
  assert.equal(metric(analysis, "kda").communityValue, 4.75);
  assert.equal(metric(analysis, "average-kills").value, 7);
  assert.equal(metric(analysis, "average-kills").communityValue, 7.25);
  assert.equal(metric(analysis, "net-worth-per-minute").value, 45);
  assert.equal(metric(analysis, "net-worth-per-minute").communityValue, 1000);
  assert.equal(metric(analysis, "player-damage-per-minute").value, 200);
  assert.equal(metric(analysis, "damage-taken-per-minute").value, 100);
  assert.equal(metric(analysis, "accuracy").value, 0.65);
  assert.equal(metric(analysis, "accuracy").communityDisplayValue, "52.0%");
  assert.ok(Math.abs(metric(analysis, "critical-hit-rate").value - 0.15) < 1e-12);
  assert.equal(metric(analysis, "boss-damage-per-minute").value, 5);
  assert.equal(metric(analysis, "healing-per-minute").value, 20);
  assert.equal(analysis.supplemental.averageMvp.value, 3);
  assert.ok(Math.abs(analysis.supplemental.killParticipation.value - ((14 / 15 + 6 / 10) / 2)) < 1e-12);
});

test("analyzePlayer marks missing or non-numeric community averages unavailable", () => {
  const analysis = analyzePlayer({
    accountId: 7,
    metadata,
    community: {
      data: {
        kd: { avg: "not-a-number" },
        kda: {},
        accuracy: { avg: 0.5 },
      },
    },
  });

  assert.equal(metric(analysis, "kd").communityValue, null);
  assert.equal(metric(analysis, "kd").communityDisplayValue, null);
  assert.equal(metric(analysis, "kda").communityValue, null);
  assert.equal(metric(analysis, "accuracy").communityValue, 0.5);
  assert.equal(metric(analysis, "accuracy").communityDisplayValue, "50.0%");
});

test("analyzePlayer avoids NaN and Infinity for zero denominators", () => {
  const analysis = analyzePlayer({
    accountId: 7,
    metadata: {
      data: [{
        duration_s: 0,
        players: [{
          account_id: 7,
          team: 0,
          kills: 5,
          deaths: 0,
          assists: 0,
          final_stats: {
            max_player_damage: 0,
            max_player_damage_taken: 0,
            max_boss_damage: 0,
            max_shots_hit: 0,
            max_shots_missed: 0,
            max_hero_bullets_hit_crit: 0,
            max_hero_bullets_hit: 0,
          },
        }],
      }],
    },
    community: { data: {} },
  });

  for (const entry of analysis.metrics) {
    assert.ok(entry.value === null || Number.isFinite(entry.value), entry.id);
  }
  assert.equal(metric(analysis, "kd").value, 5);
  assert.equal(metric(analysis, "accuracy").value, 0);
  assert.equal(metric(analysis, "critical-hit-rate").value, 0);
  assert.equal(analysis.supplemental.killParticipation.value, 1);
});

test("analyzePlayer returns stable unavailable values when the target is missing", () => {
  const analysis = analyzePlayer({
    accountId: 7,
    metadata: { data: [{ duration_s: 600, players: [{ account_id: 8, team: 0, kills: 1 }] }] },
    community: { data: { kills: { avg: 4 } } },
  });

  assert.equal(analysis.sampleSize, 0);
  assert.equal(analysis.totalDurationSeconds, 0);
  assert.ok(analysis.metrics.every((entry) => (
    entry.value === null &&
    entry.displayValue === null
  )));
  assert.equal(metric(analysis, "average-kills").communityValue, 4);
  assert.equal(metric(analysis, "average-kills").communityDisplayValue, "4.00");
  assert.equal(analysis.supplemental.averageMvp.value, null);
  assert.equal(analysis.supplemental.killParticipation.value, null);
});

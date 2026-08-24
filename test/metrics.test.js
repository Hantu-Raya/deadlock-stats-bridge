import test from "node:test";
import assert from "node:assert/strict";

import { analyzePlayer } from "../src/metrics.js";

function metric(analysis, id) {
  return analysis.metrics.find((entry) => entry.id === id);
}

function thresholds(values) {
  return {
    percentile1: values[0] ?? 0,
    percentile5: values[1] ?? 0,
    percentile10: values[2] ?? 0,
    percentile25: values[3] ?? 0,
    percentile50: values[4] ?? 0,
    percentile75: values[5] ?? 0,
    percentile90: values[6] ?? 0,
    percentile95: values[7] ?? 0,
    percentile99: values[8] ?? 0,
  };
}

const community = {
  data: {
    kills: thresholds([1, 2, 3, 4, 5, 7, 8, 9, 10]),
    deaths: thresholds([0, 1, 1, 2, 2, 3, 4, 5, 6]),
    assists: thresholds([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    kd: thresholds([0, 1, 2, 2.5, 3, 4, 5, 6, 7]),
    kda: thresholds([0, 1, 2, 4, 5, 6, 7, 8, 9]),
    net_worth_per_min: thresholds([10, 20, 25, 30, 45, 50, 60, 70, 80]),
    player_damage_per_min: thresholds([25, 50, 75, 100, 200, 250, 300, 400, 500]),
    player_damage_taken_per_min: thresholds([10, 20, 30, 40, 50, 60, 70, 80, 90]),
    accuracy: thresholds([0.1, 0.2, 0.3, 0.4, 0.65, 0.7, 0.8, 0.9, 0.95]),
    crit_shot_rate: thresholds([0.01, 0.05, 0.1, 0.12, 0.15, 0.2, 0.3, 0.4, 0.5]),
    boss_damage_per_min: thresholds([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    healing_per_min: thresholds([1, 5, 10, 15, 20, 25, 30, 40, 50]),
    mvp_rank: thresholds([1, 1, 2, 2, 3, 4, 5, 6, 7]),
    kill_participation: thresholds([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
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

test("analyzePlayer aggregates target rows and buckets exact community thresholds", () => {
  const analysis = analyzePlayer({ accountId: 7, metadata, community });
  assert.equal(analysis.sampleSize, 2);
  assert.equal(analysis.totalDurationSeconds, 1800);

  assert.equal(metric(analysis, "kd").value, 3);
  assert.equal(metric(analysis, "kd").percentile, 50);
  assert.equal(metric(analysis, "kd").percentileSource, "community distribution");
  assert.equal(metric(analysis, "kda").value, 4.25);
  assert.equal(metric(analysis, "kda").percentile, 25);
  assert.equal(metric(analysis, "average-kills").value, 7);
  assert.equal(metric(analysis, "average-kills").percentile, 75);
  assert.equal(metric(analysis, "net-worth-per-minute").value, 45);
  assert.equal(metric(analysis, "net-worth-per-minute").percentile, 50);
  assert.equal(metric(analysis, "player-damage-per-minute").value, 200);
  assert.equal(metric(analysis, "damage-taken-per-minute").value, 100);
  assert.equal(metric(analysis, "accuracy").value, 0.65);
  assert.ok(Math.abs(metric(analysis, "critical-hit-rate").value - 0.15) < 1e-12);
  assert.equal(metric(analysis, "boss-damage-per-minute").value, 5);
  assert.equal(metric(analysis, "healing-per-minute").value, 20);
  assert.equal(analysis.supplemental.averageMvp.value, 3);
  assert.ok(Math.abs(analysis.supplemental.killParticipation.value - ((14 / 15 + 6 / 10) / 2)) < 1e-12);
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
});

test("analyzePlayer returns stable unavailable values when the target is missing", () => {
  const analysis = analyzePlayer({
    accountId: 7,
    metadata: { data: [{ duration_s: 600, players: [{ account_id: 8, team: 0, kills: 1 }] }] },
    community: { data: { kills: thresholds([0, 0, 0, 0, 0, 0, 0, 0, 0]) } },
  });

  assert.equal(analysis.sampleSize, 0);
  assert.equal(analysis.totalDurationSeconds, 0);
  assert.ok(analysis.metrics.every((entry) => entry.value === null && entry.percentile === null));
  assert.equal(analysis.supplemental.averageMvp.value, null);
  assert.equal(analysis.supplemental.killParticipation.value, null);
});

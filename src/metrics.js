export const MAX_METADATA_MATCHES = 200;
export const MAX_PLAYERS_PER_MATCH = 32;

const METRIC_DEFINITIONS = [
  { id: "kd", label: "K/D", unit: "ratio", communityField: "kd", format: formatRatio, calculate: (row) => ratio(row.kills, row.deaths) },
  { id: "kda", label: "KDA", unit: "ratio", communityField: "kda", format: formatRatio, calculate: (row) => ratio(add(row.kills, row.assists), row.deaths) },
  { id: "average-kills", label: "Average kills", unit: "kills/match", communityField: "kills", format: formatNumber, calculate: (row) => row.kills },
  { id: "average-deaths", label: "Average deaths", unit: "deaths/match", communityField: "deaths", format: formatNumber, calculate: (row) => row.deaths },
  { id: "average-assists", label: "Average assists", unit: "assists/match", communityField: "assists", format: formatNumber, calculate: (row) => row.assists },
  { id: "net-worth-per-minute", label: "Net worth per minute", unit: "net worth/min", communityField: "net_worth_per_min", format: formatNumber, calculate: (row) => perMinute(row.netWorth, row.durationSeconds) },
  { id: "player-damage-per-minute", label: "Player damage per minute", unit: "damage/min", communityField: "player_damage_per_min", format: formatNumber, calculate: (row) => perMinute(row.playerDamage, row.durationSeconds) },
  { id: "damage-taken-per-minute", label: "Damage taken per minute", unit: "damage taken/min", communityField: "player_damage_taken_per_min", format: formatNumber, calculate: (row) => perMinute(row.playerDamageTaken, row.durationSeconds) },
  { id: "accuracy", label: "Accuracy", unit: "%", communityField: "accuracy", format: formatPercent, calculate: (row) => ratio(row.shotsHit, add(row.shotsHit, row.shotsMissed)) },
  { id: "critical-hit-rate", label: "Critical-hit rate", unit: "%", communityField: "crit_shot_rate", format: formatPercent, calculate: (row) => ratio(row.criticalBullets, add(row.criticalBullets, row.heroBullets)) },
  { id: "boss-damage-per-minute", label: "Boss damage per minute", unit: "boss damage/min", communityField: "boss_damage_per_min", format: formatNumber, calculate: (row) => perMinute(row.bossDamage, row.durationSeconds) },
  { id: "healing-per-minute", label: "Healing per minute", unit: "healing/min", communityField: "healing_per_min", format: formatNumber, calculate: (row) => perMinute(row.healing, row.durationSeconds) },
];

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number);
}

function add(left, right) {
  return left === null || right === null ? null : left + right;
}

function ratio(numerator, denominator) {
  if (numerator === null || denominator === null) return null;
  return numerator / Math.max(1, denominator);
}

function perMinute(value, durationSeconds) {
  if (value === null || durationSeconds === null) return null;
  return value / (Math.max(1, durationSeconds) / 60);
}

function mean(values) {
  const valid = values.filter((value) => value !== null && Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((total, value) => total + value, 0) / valid.length;
}

function formatNumber(value) {
  return value === null ? null : value.toFixed(2);
}

function formatRatio(value) {
  return formatNumber(value);
}

function formatPercent(value) {
  return value === null ? null : `${(value * 100).toFixed(1)}%`;
}

function unwrapData(value) {
  if (!value || typeof value !== "object") return value;
  if ("data" in value && value.data !== undefined) return value.data;
  return value;
}

function asArray(value) {
  const data = unwrapData(value);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.matches)) return data.matches;
  return [];
}

function readPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function numberFromValue(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const number = nonNegative(value[index]);
      if (number !== null) return number;
    }
    return null;
  }
  if (value && typeof value === "object" && "value" in value) return nonNegative(value.value);
  return nonNegative(value);
}

function readPlayerNumber(player, names) {
  const containers = [
    player,
    player?.final_stats,
    player?.stats,
    player?.final_stats?.stats,
  ];
  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    for (const name of names) {
      const value = numberFromValue(readPath(container, name));
      if (value !== null) return value;
    }
  }
  return null;
}

function playerAccountId(player) {
  if (!player || typeof player !== "object") return null;
  return player.account_id ?? player.accountId ?? null;
}

function sameAccount(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

function playerTeam(player) {
  if (!player || typeof player !== "object") return null;
  return player.team ?? player.team_id ?? player.teamId ?? null;
}

function sameTeam(left, right) {
  return left !== null && right !== null && String(left) === String(right);
}

function readMatchDuration(match) {
  return nonNegative(match?.duration_s ?? match?.durationSeconds ?? match?.duration);
}

function readMatchRows(metadata, accountId) {
  const rows = [];
  const matches = asArray(metadata);
  if (matches.length > MAX_METADATA_MATCHES) throw new RangeError("metadata match count exceeds limit");
  for (const match of matches) {
    const players = Array.isArray(match?.players) ? match.players : [];
    if (players.length > MAX_PLAYERS_PER_MATCH) throw new RangeError("metadata player count exceeds limit");
    const player = players.find((candidate) => sameAccount(playerAccountId(candidate), accountId));
    if (!player) continue;
    const durationSeconds = readMatchDuration(match);
    const row = {
      match,
      players,
      player,
      durationSeconds,
      kills: readPlayerNumber(player, ["kills"]),
      deaths: readPlayerNumber(player, ["deaths"]),
      assists: readPlayerNumber(player, ["assists"]),
      netWorth: readPlayerNumber(player?.final_stats ?? {}, ["net_worth", "netWorth"]) ?? readPlayerNumber(player, ["net_worth", "netWorth"]),
      playerDamage: readPlayerNumber(player, ["player_damage", "max_player_damage"]),
      playerDamageTaken: readPlayerNumber(player, ["player_damage_taken", "max_player_damage_taken"]),
      bossDamage: readPlayerNumber(player, ["boss_damage", "max_boss_damage"]),
      selfHealing: readPlayerNumber(player, ["self_healing", "max_self_healing"]),
      playerHealing: readPlayerNumber(player, ["player_healing", "max_player_healing"]),
      healing: readPlayerNumber(player, ["healing", "max_healing"]),
      shotsHit: readPlayerNumber(player, ["shots_hit", "max_shots_hit"]),
      shotsMissed: readPlayerNumber(player, ["shots_missed", "max_shots_missed"]),
      criticalBullets: readPlayerNumber(player, ["hero_bullets_hit_crit", "max_hero_bullets_hit_crit"]),
      heroBullets: readPlayerNumber(player, ["hero_bullets_hit", "max_hero_bullets_hit"]),
      mvpRank: readPlayerNumber(player, ["mvp_rank", "mvpRank"]),
    };
    if (row.healing === null) row.healing = add(row.selfHealing, row.playerHealing);
    rows.push(row);
  }
  return rows;
}

function killParticipation(row) {
  const team = playerTeam(row.player);
  const teamKills = row.players
    .filter((player) => sameTeam(playerTeam(player), team))
    .map((player) => readPlayerNumber(player, ["kills"]))
    .filter((value) => value !== null);
  if (teamKills.length === 0 || row.kills === null || row.assists === null) return null;
  const teamKillTotal = teamKills.reduce((total, value) => total + value, 0);
  if (teamKillTotal <= 0) return null;
  return (row.kills + row.assists) / teamKillTotal;
}

function communityRoot(community) {
  const root = unwrapData(community);
  if (root?.metrics && typeof root.metrics === "object") return root.metrics;
  if (root?.data && typeof root.data === "object" && !Array.isArray(root.data)) return root.data;
  return root;
}

function communityAverage(community, field) {
  const root = communityRoot(community);
  if (!root || typeof root !== "object") return null;
  return finiteNumber(root[field]?.avg);
}

function supplementalValue(value, unit, format) {
  return { value, displayValue: format(value), unit };
}

function aggregateRows(rows) {
  const totalDurationSeconds = rows.reduce((total, row) => total + (row.durationSeconds ?? 0), 0);
  const metrics = METRIC_DEFINITIONS.map((definition) => {
    const value = mean(rows.map(definition.calculate));
    return {
      id: definition.id,
      label: definition.label,
      value,
      displayValue: definition.format(value),
      communityValue: null,
      communityDisplayValue: null,
      unit: definition.unit,
    };
  });
  const averageMvp = mean(rows.map((row) => row.mvpRank));
  const participation = mean(rows.map(killParticipation));
  return {
    sampleSize: rows.length,
    totalDurationSeconds,
    metrics,
    supplemental: {
      averageMvp: supplementalValue(averageMvp, "rank", formatNumber),
      killParticipation: supplementalValue(participation, "%", formatPercent),
    },
  };
}

export function aggregatePlayer({ accountId, metadata } = {}) {
  return aggregateRows(readMatchRows(metadata, accountId));
}

export function aggregatePlayerPrefixes({ accountId, metadata, limits = [25, 50, 100, 150, 200] } = {}) {
  const rows = readMatchRows(metadata, accountId);
  const samples = {};
  for (const limit of limits) {
    if (!Number.isSafeInteger(limit) || limit < 1) continue;
    samples[String(limit)] = aggregateRows(rows.slice(0, limit));
  }
  const availableMatches = asArray(metadata).length;
  return {
    maxMatches: availableMatches,
    samples,
  };
}

export function composePlayerWithCommunity(playerAggregate, community) {
  if (!playerAggregate || typeof playerAggregate !== "object") return null;
  const metrics = Array.isArray(playerAggregate.metrics)
    ? playerAggregate.metrics.map((metric) => {
        const definition = METRIC_DEFINITIONS.find((candidate) => candidate.id === metric?.id);
        const communityValue = definition ? communityAverage(community, definition.communityField) : null;
        return {
          ...metric,
          communityValue,
          communityDisplayValue: definition ? definition.format(communityValue) : null,
        };
      })
    : [];
  return { ...playerAggregate, metrics };
}

export function composeAnalysis({ player, community } = {}) {
  return composePlayerWithCommunity(player, community);
}

export function analyzePlayer({ accountId, metadata, community } = {}) {
  return composeAnalysis({ player: aggregatePlayer({ accountId, metadata }), community });
}

export {
  METRIC_DEFINITIONS,
  communityAverage,
  formatNumber,
  formatPercent,
};

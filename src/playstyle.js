// Display page for the ShowRank playstyle radar on the profile page.
// Each axis is the player's 30-day average placed in the community's distribution for the same window.
// Panorama shows this page in a noninteractive CitadelHTMLPanel and reads only the status title.
import { ApiError, fetchEnvelope } from "./api.js?v=20261019-2";
import { interpolatePercentile } from "./metrics.js?v=20261019-2";
import { readCache, writeCache } from "./page-cache.js?v=20261019-2";

export const PLAY_TITLE_PREFIX = "DLPLAY1:";
export const PLAY_PROTOCOL = 1;
export const COHORT_DAYS = 30;
const API_ORIGIN = "https://api.deadlock-api.com";
const MATCH_MODES = "ranked,unranked";
const EARLY_TIME_S = 600;
const ACCOUNT_TTL_MS = 10 * 60 * 1000;
const COMMUNITY_TTL_MS = 60 * 60 * 1000;
const ACCOUNT_PREFIX = "dlps:account:v1:";
const COMMUNITY_PREFIX = "dlps:community:v1:";
const MAX_ACCOUNT_ENTRIES = 8;
const REQUEST_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_PATTERN = /^[1-9][0-9]{0,9}$/;
const MAX_ACCOUNT = 4294967295;
const DAY_S = 86400;
const GREEN = "#7ee2a8";

/** Clockwise from the top, matching the reference layout. */
export const AXES = Object.freeze([
  Object.freeze({ id: "damage", label: "DAMAGE DEALER", field: "player_damage_per_min" }),
  Object.freeze({ id: "farming", label: "FARMING", field: "net_worth_per_min" }),
  Object.freeze({ id: "tank", label: "TANK", field: "player_damage_taken_per_min" }),
  Object.freeze({ id: "support", label: "SUPPORT", field: "player_healing_per_min" }),
  Object.freeze({ id: "early", label: "EARLY IMPACT", field: null }),
  Object.freeze({ id: "pusher", label: "PUSHER", field: "boss_damage_per_min" }),
]);

const invalidPayload = () => new ApiError("Deadlock API payload is invalid", { code: "invalid_payload" });

export function parsePlaystyleQuery(search) {
  let params;
  try { params = new URLSearchParams(typeof search === "string" ? search : ""); } catch { return null; }
  if (params.get("protocol") !== String(PLAY_PROTOCOL)) return null;
  const request = params.get("request");
  const accountText = params.get("account_id");
  if (typeof request !== "string" || !REQUEST_PATTERN.test(request)) return null;
  if (typeof accountText !== "string" || !ACCOUNT_PATTERN.test(accountText) || Number(accountText) > MAX_ACCOUNT) return null;
  return { request, account: Number(accountText) };
}

/** Start of the 30-day window, rounded down to a UTC day so URLs and cache keys stay stable within a day. */
export function cohortStart(nowMs) {
  return Math.floor(nowMs / 1000 / DAY_S) * DAY_S - COHORT_DAYS * DAY_S;
}

export function playstyleUrls(account, since) {
  const query = (path, extra) => {
    const url = new URL(path, API_ORIGIN);
    if (extra) for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    url.searchParams.set("match_mode", MATCH_MODES);
    url.searchParams.set("min_unix_timestamp", String(since));
    return url.toString();
  };
  return {
    accountMetrics: query("/v1/analytics/player-stats/metrics", { account_ids: String(account) }),
    communityMetrics: query("/v1/analytics/player-stats/metrics"),
    accountCurve: query("/v1/analytics/player-performance-curve", { resolution: "0", account_ids: String(account) }),
    communityCurve: query("/v1/analytics/player-performance-curve", { resolution: "0" }),
  };
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(z) {
  if (z === 0) return 0.5;
  if (z < 0) return 1 - normalCdf(-z);
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * (1 + (1 - poly * Math.exp(-x * x)));
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Linear interpolation of the curve's samples around `time`; null without a sample on each side. */
function sampleAt(curve, time) {
  if (!Array.isArray(curve)) return null;
  const points = curve.filter((point) => point && Number.isFinite(point.game_time)).sort((a, b) => a.game_time - b.game_time);
  const after = points.find((point) => point.game_time >= time);
  const before = [...points].reverse().find((point) => point.game_time <= time);
  if (!after || !before) return null;
  const fields = ["net_worth_avg", "net_worth_std", "kills_avg", "kills_std", "assists_avg", "assists_std"];
  const share = after.game_time === before.game_time ? 0 : (time - before.game_time) / (after.game_time - before.game_time);
  const sample = {};
  for (const field of fields) {
    const low = finite(before[field]);
    const high = finite(after[field]);
    if (low === null || high === null) return null;
    sample[field] = low + (high - low) * share;
  }
  return sample;
}

/**
 * Net worth and kills + assists at 10:00, each as the normal-CDF position of the player's average against the
 * community mean and spread, averaged. The kills + assists spread assumes independence (an approximation).
 */
export function earlyImpactScore(accountCurve, communityCurve) {
  const player = sampleAt(accountCurve, EARLY_TIME_S);
  const community = sampleAt(communityCurve, EARLY_TIME_S);
  if (!player || !community) return null;
  const netWorthSpread = community.net_worth_std;
  const killsAssistsSpread = Math.sqrt(community.kills_std ** 2 + community.assists_std ** 2);
  if (!(netWorthSpread > 0) || !(killsAssistsSpread > 0)) return null;
  const netWorth = normalCdf((player.net_worth_avg - community.net_worth_avg) / netWorthSpread);
  const killsAssists = normalCdf(((player.kills_avg + player.assists_avg) - (community.kills_avg + community.assists_avg)) / killsAssistsSpread);
  return Math.min(99, Math.max(1, ((netWorth + killsAssists) / 2) * 100));
}

export function scoreAxes({ accountMetrics, communityMetrics, accountCurve, communityCurve }) {
  return AXES.map((axis) => {
    let score = null;
    if (axis.id === "early") {
      score = earlyImpactScore(accountCurve, communityCurve);
    } else {
      const average = finite(accountMetrics?.[axis.field]?.avg);
      const entry = communityMetrics?.[axis.field];
      score = average === null || !entry ? null : interpolatePercentile(average, entry);
    }
    return { id: axis.id, label: axis.label, score: score === null ? null : Math.round(score * 10) / 10 };
  });
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const round = (value) => Math.round(value * 100) / 100;

export function buildRadarSvg(axes, { width = 400, height = 260 } = {}) {
  const w = Math.max(240, Math.round(width));
  const h = Math.max(180, Math.round(height));
  const cx = w / 2;
  const cy = h / 2 - 12;
  const radius = Math.min(w / 2 - 112, h / 2 - 40);
  const angle = (index) => -Math.PI / 2 + (index * 2 * Math.PI) / axes.length;
  const at = (index, share) => [cx + Math.cos(angle(index)) * radius * share, cy + Math.sin(angle(index)) * radius * share];
  const ring = (share) => axes.map((_, index) => at(index, share).map(round).join(",")).join(" ");
  const known = axes.filter((axis) => axis.score !== null);
  const top = known.length ? Math.max(...known.map((axis) => axis.score)) : null;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Radiance, Segoe UI, sans-serif">`];
  for (const share of [0.25, 0.5, 0.75, 1]) {
    parts.push(`<polygon points="${ring(share)}" fill="none" stroke="#ffffff" stroke-opacity="${share === 1 ? 0.45 : 0.2}"/>`);
  }
  axes.forEach((_, index) => {
    const [x, y] = at(index, 1);
    parts.push(`<line x1="${round(cx)}" y1="${round(cy)}" x2="${round(x)}" y2="${round(y)}" stroke="#ffffff" stroke-opacity="0.2"/>`);
  });
  if (known.length === axes.length) {
    const shape = axes.map((axis, index) => at(index, axis.score / 100).map(round).join(",")).join(" ");
    parts.push(`<polygon points="${shape}" fill="${GREEN}" fill-opacity="0.4" stroke="${GREEN}" stroke-width="2.5"/>`);
  }
  axes.forEach((axis, index) => {
    if (axis.score === null) return;
    const [x, y] = at(index, axis.score / 100);
    parts.push(`<circle cx="${round(x)}" cy="${round(y)}" r="3" fill="#ffffff" stroke="${GREEN}" stroke-width="1"/>`);
  });
  axes.forEach((axis, index) => {
    const [x, y] = at(index, 1.12);
    const cos = Math.cos(angle(index));
    const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
    const dy = Math.sin(angle(index)) < -0.5 ? -4 : Math.sin(angle(index)) > 0.5 ? 12 : 4;
    const highlighted = axis.score !== null && top !== null && top - axis.score <= 0.5;
    const fill = highlighted ? GREEN : "#ffffff";
    parts.push(`<text fill="${fill}" x="${round(x)}" y="${round(y + dy)}" font-size="13" font-weight="800" letter-spacing="0.6" text-anchor="${anchor}">${escapeText(axis.label)}</text>`);
    if (axis.score === null) {
      parts.push(`<text fill="#bdbdbd" x="${round(x)}" y="${round(y + dy + 14)}" font-size="11" font-weight="700" text-anchor="${anchor}">N/A</text>`);
    }
  });
  parts.push(`<text fill="#bdbdbd" x="${round(cx)}" y="${h - 4}" font-size="11" font-weight="700" letter-spacing="1" text-anchor="middle">LAST 30 DAYS · RANKED + STANDARD</text>`);
  parts.push("</svg>");
  return parts.join("");
}

function readMetrics(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidPayload();
  const metrics = {};
  for (const axis of AXES) {
    if (!axis.field) continue;
    const entry = data[axis.field];
    if (entry !== undefined && (entry === null || typeof entry !== "object" || Array.isArray(entry))) throw invalidPayload();
    if (entry) metrics[axis.field] = entry;
  }
  return metrics;
}

function readCurve(data) {
  if (!Array.isArray(data)) throw invalidPayload();
  return data
    .filter((point) => point && typeof point === "object" && Number.isFinite(point.game_time) && point.game_time <= 1200)
    .map((point) => ({
      game_time: point.game_time,
      net_worth_avg: point.net_worth_avg, net_worth_std: point.net_worth_std,
      kills_avg: point.kills_avg, kills_std: point.kills_std,
      assists_avg: point.assists_avg, assists_std: point.assists_std,
    }));
}

async function loadCached(key, ttl, deps, bound, load) {
  const cached = readCache(deps.storage, key, ttl, deps.now());
  if (cached) return cached;
  const value = await load();
  writeCache(deps.storage, key, value, deps.now(), bound);
  return value;
}

async function fetchJson(url, deps) {
  const { data } = await fetchEnvelope(url, deps.fetchImpl, deps.signal);
  return data;
}

function errorCode(error) {
  if (error?.code === "invalid_payload") return "invalid_payload";
  if (error instanceof ApiError || error?.name === "ApiError") {
    if (error.status === 429) return "rate_limit";
    if (Number.isInteger(error.status) && error.status > 0) return "upstream_error";
  }
  return "network_error";
}

function publish(payload, documentRef, locationRef) {
  const title = PLAY_TITLE_PREFIX + JSON.stringify({ v: PLAY_PROTOCOL, ...payload });
  try {
    documentRef.title = title;
    if (locationRef) locationRef.hash = encodeURIComponent(title);
  } catch {
    /* page is unloading */
  }
}

function showMessage(documentRef, text) {
  try {
    documentRef.body.innerHTML = `<p class="message">${escapeText(text)}</p>`;
  } catch {
    /* page is unloading */
  }
}

export async function runPlaystyle({
  documentRef = globalThis.document ?? null,
  locationRef = globalThis.location ?? null,
  fetchImpl = globalThis.fetch,
  storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })(),
  now = () => Date.now(),
  viewport = () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }),
  resizeTarget = globalThis.window ?? null,
  signal,
} = {}) {
  const query = parsePlaystyleQuery(locationRef?.search ?? "");
  if (!query) {
    showMessage(documentRef, "Playstyle unavailable.");
    publish({ request: "", kind: "error", code: "invalid_query" }, documentRef, locationRef);
    return { ok: false, code: "invalid_query" };
  }
  const deps = { fetchImpl, storage, now, signal };
  const since = cohortStart(now());
  const urls = playstyleUrls(query.account, since);
  let data;
  try {
    const [community, account] = await Promise.all([
      loadCached(`${COMMUNITY_PREFIX}${since}`, COMMUNITY_TTL_MS, deps, { prefix: COMMUNITY_PREFIX, max: 1 }, async () => {
        const [metrics, curve] = await Promise.all([fetchJson(urls.communityMetrics, deps), fetchJson(urls.communityCurve, deps)]);
        return { metrics: readMetrics(metrics), curve: readCurve(curve) };
      }),
      loadCached(`${ACCOUNT_PREFIX}${query.account}:${since}`, ACCOUNT_TTL_MS, deps, { prefix: ACCOUNT_PREFIX, max: MAX_ACCOUNT_ENTRIES }, async () => {
        const [metrics, curve] = await Promise.all([fetchJson(urls.accountMetrics, deps), fetchJson(urls.accountCurve, deps)]);
        return { metrics: readMetrics(metrics), curve: readCurve(curve) };
      }),
    ]);
    data = { accountMetrics: account.metrics, accountCurve: account.curve, communityMetrics: community.metrics, communityCurve: community.curve };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { ok: false, code: "aborted" };
    const code = errorCode(error);
    showMessage(documentRef, code === "rate_limit" ? "Playstyle unavailable: the stats service is busy." : "Playstyle unavailable.");
    publish({ request: query.request, kind: "error", code }, documentRef, locationRef);
    return { ok: false, code };
  }
  if (signal?.aborted) return { ok: false, code: "aborted" };
  const axes = scoreAxes(data);
  const known = axes.filter((axis) => axis.score !== null).length;
  if (!known) {
    showMessage(documentRef, "No matches in the last 30 days.");
    publish({ request: query.request, kind: "empty", axes: 0 }, documentRef, locationRef);
    return { ok: true, axes: 0 };
  }
  // Panorama can load the page before laying out its panel, so draw at the current size and redraw on resize.
  const draw = () => {
    const size = viewport();
    try {
      documentRef.body.innerHTML = buildRadarSvg(axes, { width: size.width || 400, height: size.height || 260 });
    } catch {
      /* page is unloading */
    }
  };
  draw();
  resizeTarget?.addEventListener?.("resize", draw);
  publish({ request: query.request, kind: "ready", axes: known }, documentRef, locationRef);
  return { ok: true, axes: known };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  window.addEventListener?.("pagehide", () => controller?.abort(), { once: true });
  void runPlaystyle({ signal: controller?.signal });
}

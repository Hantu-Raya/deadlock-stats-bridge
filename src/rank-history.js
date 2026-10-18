// Display page for the ShowRank "Rank History" profile tab.
// Panorama shows this page in a noninteractive CitadelHTMLPanel and reads only the status title.
import { ApiError, fetchEnvelope } from "./api.js?v=20261019-2";
import { readCache, writeCache } from "./page-cache.js?v=20261019-2";

export const RANK_TITLE_PREFIX = "DLRANKH1:";
export const RANK_PROTOCOL = 1;
export const GROUP_SIZES = Object.freeze([1, 5, 10, 25]);
export const HISTORY_TTL_MS = 5 * 60 * 1000;
export const RANKS_TTL_MS = 60 * 60 * 1000;
const API_ORIGIN = "https://api.deadlock-api.com";
const HISTORY_PREFIX = "dlrh:history:v1:";
const RANKS_KEY = "dlrh:ranks:v1";
const MAX_HISTORY_ENTRIES = 8;
const REQUEST_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_PATTERN = /^[1-9][0-9]{0,9}$/;
const MAX_ACCOUNT = 4294967295;
const RANKED_MATCH_MODE = 4;
const MAX_TIER = 11;
const SUBRANKS = 6;
const ICON_ORIGIN = "https://assets-bucket.deadlock-api.com/";

const invalidPayload = () => new ApiError("Deadlock API payload is invalid", { code: "invalid_payload" });

export function parseRankQuery(search) {
  let params;
  try { params = new URLSearchParams(typeof search === "string" ? search : ""); } catch { return null; }
  if (params.get("protocol") !== String(RANK_PROTOCOL)) return null;
  const request = params.get("request");
  const accountText = params.get("account_id");
  const group = Number(params.get("group"));
  if (typeof request !== "string" || !REQUEST_PATTERN.test(request)) return null;
  if (typeof accountText !== "string" || !ACCOUNT_PATTERN.test(accountText) || Number(accountText) > MAX_ACCOUNT) return null;
  if (!GROUP_SIZES.includes(group) || params.get("group") !== String(group)) return null;
  return { request, account: Number(accountText), group };
}

/** Badge 96 is tier 9 subrank 6. Returns the continuous ordinal (tier - 1) * 6 + subrank, or 0 when invalid. */
export function badgeOrdinal(badge) {
  if (!Number.isSafeInteger(badge)) return 0;
  const tier = Math.floor(badge / 10);
  const subrank = badge % 10;
  if (tier < 1 || tier > MAX_TIER || subrank < 1 || subrank > SUBRANKS) return 0;
  return (tier - 1) * SUBRANKS + subrank;
}

/** Ranked matches with a valid badge, deduplicated by match id, oldest first, as [startTime, ordinal]. */
export function normalizeHistory(data) {
  if (!Array.isArray(data)) throw invalidPayload();
  const byMatch = new Map();
  for (const row of data) {
    if (!row || typeof row !== "object" || row.match_mode !== RANKED_MATCH_MODE) continue;
    if (!Number.isSafeInteger(row.match_id) || !Number.isSafeInteger(row.start_time) || row.start_time <= 0) continue;
    const ordinal = badgeOrdinal(row.ranked_display_badge);
    if (ordinal && !byMatch.has(row.match_id)) byMatch.set(row.match_id, [row.start_time, ordinal, row.match_id]);
  }
  return [...byMatch.values()]
    .sort((a, b) => a[0] - b[0] || a[2] - b[2])
    .map(([time, ordinal]) => [time, ordinal]);
}

function safeIcon(value) {
  return typeof value === "string" && value.startsWith(ICON_ORIGIN) && !/["'<>\s]/.test(value) ? value : "";
}

function safeColor(value) {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : "";
}

export function normalizeRanks(data) {
  if (!Array.isArray(data)) throw invalidPayload();
  const ranks = [];
  for (const rank of data) {
    if (!rank || !Number.isSafeInteger(rank.tier) || rank.tier < 1 || rank.tier > MAX_TIER) continue;
    if (typeof rank.name !== "string" || !rank.name) continue;
    ranks.push({ tier: rank.tier, name: rank.name.slice(0, 32), color: safeColor(rank.color), icon: safeIcon(rank.images?.large_webp) });
  }
  return ranks.sort((a, b) => a.tier - b.tier);
}

/** Non-overlapping buckets of `size` points, oldest first; each point sits at its bucket's last date. */
export function groupPoints(points, size) {
  if (size <= 1) return points.map(([time, ordinal]) => [time, ordinal]);
  const grouped = [];
  for (let start = 0; start < points.length; start += size) {
    const bucket = points.slice(start, start + size);
    const mean = bucket.reduce((sum, [, ordinal]) => sum + ordinal, 0) / bucket.length;
    grouped.push([bucket[bucket.length - 1][0], Math.round(mean * 100) / 100]);
  }
  return grouped;
}

const round = (value) => Math.round(value * 100) / 100;

/** Fritsch-Carlson monotone cubic through strictly increasing xs; no overshoot between neighbours. */
export function monotonePath(xs, ys) {
  const n = xs.length;
  if (!n) return "";
  if (n === 1) return `M${round(xs[0])},${round(ys[0])}`;
  const slopes = [];
  for (let i = 0; i < n - 1; i += 1) slopes.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const tangents = [slopes[0]];
  for (let i = 1; i < n - 1; i += 1) {
    tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  }
  tangents.push(slopes[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangents[i] = t * a * slopes[i];
      tangents[i + 1] = t * b * slopes[i];
    }
  }
  let path = `M${round(xs[0])},${round(ys[0])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    path += ` C${round(xs[i] + dx)},${round(ys[i] + tangents[i] * dx)} ${round(xs[i + 1] - dx)},${round(ys[i + 1] - tangents[i + 1] * dx)} ${round(xs[i + 1])},${round(ys[i + 1])}`;
  }
  return path;
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function formatDate(seconds) {
  try {
    return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// Panorama screen-blends this page (black = transparent) over a native dark shade panel that spans the
// same width insets, so the plot edges are shares of the width, not pixels: UI scale changes both alike.
export const PLOT_LEFT_SHARE = 0.12;
export const PLOT_RIGHT_SHARE = 0.15;
const ACCENT = "#7ee2a8";
const MUTED = "#c4c9d0";
const MAX_MARKED_POINTS = 40;

// Mixes an API rank colour 35% toward white so dim tiers (Phantom grey) stay readable over the dark plot.
function lift(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color || "");
  if (!match) return "#ffffff";
  const value = parseInt(match[1], 16);
  return `#${[16, 8, 0].map((shift) => Math.round(((value >> shift) & 255) * 0.65 + 255 * 0.35).toString(16).padStart(2, "0")).join("")}`;
}

function rankLabel(ordinal, ranks) {
  const rounded = Math.min(MAX_TIER * SUBRANKS, Math.max(1, Math.round(ordinal)));
  const tier = Math.floor((rounded - 1) / SUBRANKS) + 1;
  const rank = ranks.find((entry) => entry.tier === tier);
  return { rank, text: `${rank?.name || `Rank ${tier}`} ${rounded - (tier - 1) * SUBRANKS}` };
}

// Layout: tier icons and names in the left gutter, tier bands behind a green line and area, and the latest
// real rank (not a group average) as a callout in the right gutter.
export function buildChartSvg(points, ranks, { width = 1000, height = 140, current } = {}) {
  const w = Math.max(320, Math.round(width));
  const h = Math.max(90, Math.round(height));
  const left = Math.round(w * PLOT_LEFT_SHARE);
  const right = Math.round(w * PLOT_RIGHT_SHARE);
  const top = 12;
  const bottom = 24;
  const ordinals = points.map(([, ordinal]) => ordinal);
  const lowTier = Math.max(1, Math.floor((Math.min(...ordinals) - 1) / SUBRANKS) + 1);
  const highTier = Math.min(MAX_TIER, Math.floor((Math.max(...ordinals) - 1) / SUBRANKS) + 1);
  const lo = (lowTier - 1) * SUBRANKS + 0.5;
  const hi = highTier * SUBRANKS + 0.5;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const plotBottom = top + plotH;
  const y = (ordinal) => top + plotH - ((ordinal - lo) / (hi - lo)) * plotH;
  const pad = 16;
  const xs = points.map((_, index) => (points.length === 1 ? left + plotW / 2 : left + pad + (index / (points.length - 1)) * (plotW - 2 * pad)));
  const ys = points.map(([, ordinal]) => y(ordinal));
  const bandH = plotH / (highTier - lowTier + 1);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Radiance, Segoe UI, sans-serif">`,
    `<defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.28"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient></defs>`,
  ];
  for (let tier = lowTier; tier <= highTier; tier += 1) {
    const rank = ranks.find((entry) => entry.tier === tier);
    const bandTop = y(tier * SUBRANKS + 0.5);
    const center = bandTop + bandH / 2;
    if ((tier - lowTier) % 2 === 0) {
      parts.push(`<rect x="${left}" y="${round(bandTop)}" width="${plotW}" height="${round(bandH)}" fill="#ffffff" fill-opacity="0.035"/>`);
    }
    if (tier > lowTier) {
      parts.push(`<line x1="${left}" x2="${left + plotW}" y1="${round(bandTop + bandH)}" y2="${round(bandTop + bandH)}" stroke="#ffffff" stroke-opacity="0.14"/>`);
    }
    const size = Math.min(24, bandH - 2);
    if (rank?.icon && size >= 10) {
      parts.push(`<image href="${rank.icon}" x="10" y="${round(center - size / 2)}" width="${round(size)}" height="${round(size)}"/>`);
    }
    if (bandH >= 13) {
      parts.push(`<text x="40" y="${round(center + 4.5)}" fill="${lift(rank?.color)}" font-size="12" font-weight="800" letter-spacing="1">${escapeText((rank?.name || `Rank ${tier}`).toUpperCase())}</text>`);
    }
  }
  parts.push(`<line data-baseline="1" x1="${left}" x2="${left + plotW}" y1="${plotBottom}" y2="${plotBottom}" stroke="#ffffff" stroke-opacity="0.22"/>`);
  const line = monotonePath(xs, ys);
  if (points.length > 1) {
    parts.push(`<path d="${line} L${round(xs.at(-1))},${plotBottom} L${round(xs[0])},${plotBottom} Z" fill="url(#area)"/>`);
  }
  parts.push(`<path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  const last = points.length - 1;
  points.forEach((_, index) => {
    if (index !== last && points.length > MAX_MARKED_POINTS) return;
    if (index === last) {
      parts.push(`<circle cx="${round(xs[index])}" cy="${round(ys[index])}" r="9" fill="${ACCENT}" fill-opacity="0.18"/>`);
      parts.push(`<circle data-point="${index}" cx="${round(xs[index])}" cy="${round(ys[index])}" r="5" fill="${ACCENT}"/>`);
    } else {
      parts.push(`<circle data-point="${index}" cx="${round(xs[index])}" cy="${round(ys[index])}" r="2.5" fill="#000000" stroke="${ACCENT}" stroke-width="1.5"/>`);
    }
  });
  const labelIndexes = new Set([0, last]);
  if (points.length >= 4) [1 / 3, 2 / 3].forEach((share) => labelIndexes.add(Math.round(last * share)));
  for (const index of [...labelIndexes].sort((a, b) => a - b)) {
    const anchor = points.length === 1 ? "middle" : index === 0 ? "start" : index === last ? "end" : "middle";
    parts.push(`<text x="${round(xs[index])}" y="${h - 7}" fill="${MUTED}" font-size="12" font-weight="700" text-anchor="${anchor}">${escapeText(formatDate(points[index][0]))}</text>`);
  }
  const callout = rankLabel(Number.isFinite(current) ? current : ordinals.at(-1), ranks);
  const cx = left + plotW + 16;
  const cy = top + plotH / 2;
    parts.push(`<text x="${cx}" y="${round(cy - 16)}" fill="${MUTED}" font-size="11" font-weight="800" letter-spacing="1.5">CURRENT</text>`);
  if (callout.rank?.icon) {
    parts.push(`<image href="${callout.rank.icon}" x="${cx}" y="${round(cy - 8)}" width="30" height="30"/>`);
  }
  parts.push(`<text data-current="1" x="${callout.rank?.icon ? cx + 36 : cx}" y="${round(cy + 13)}" fill="${lift(callout.rank?.color)}" font-size="17" font-weight="800">${escapeText(callout.text)}</text>`);
  parts.push("</svg>");
  return parts.join("");
}

async function loadRanks(deps) {
  const cached = readCache(deps.storage, RANKS_KEY, RANKS_TTL_MS, deps.now());
  if (cached) return cached;
  const { data } = await fetchEnvelope(`${API_ORIGIN}/v1/assets/ranks`, deps.fetchImpl, deps.signal);
  const ranks = normalizeRanks(data);
  writeCache(deps.storage, RANKS_KEY, ranks, deps.now());
  return ranks;
}

async function loadHistory(account, deps) {
  const key = `${HISTORY_PREFIX}${account}`;
  const cached = readCache(deps.storage, key, HISTORY_TTL_MS, deps.now());
  if (cached) return cached;
  const { data } = await fetchEnvelope(`${API_ORIGIN}/v1/players/${account}/match-history`, deps.fetchImpl, deps.signal);
  const points = normalizeHistory(data);
  writeCache(deps.storage, key, points, deps.now(), { prefix: HISTORY_PREFIX, max: MAX_HISTORY_ENTRIES });
  return points;
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
  const title = RANK_TITLE_PREFIX + JSON.stringify({ v: RANK_PROTOCOL, ...payload });
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

export async function runRankHistory({
  documentRef = globalThis.document ?? null,
  locationRef = globalThis.location ?? null,
  fetchImpl = globalThis.fetch,
  storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })(),
  now = () => Date.now(),
  viewport = () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }),
  resizeTarget = globalThis.window ?? null,
  signal,
} = {}) {
  const query = parseRankQuery(locationRef?.search ?? "");
  if (!query) {
    showMessage(documentRef, "Rank history unavailable.");
    publish({ request: "", kind: "error", code: "invalid_query" }, documentRef, locationRef);
    return { ok: false, code: "invalid_query" };
  }
  const deps = { fetchImpl, storage, now, signal };
  let ranks;
  let points;
  try {
    [ranks, points] = await Promise.all([loadRanks(deps), loadHistory(query.account, deps)]);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { ok: false, code: "aborted" };
    const code = errorCode(error);
    showMessage(documentRef, code === "rate_limit" ? "Rank history unavailable: the stats service is busy." : "Rank history unavailable.");
    publish({ request: query.request, kind: "error", code }, documentRef, locationRef);
    return { ok: false, code };
  }
  if (signal?.aborted) return { ok: false, code: "aborted" };
  const grouped = groupPoints(points, query.group);
  if (!grouped.length) {
    showMessage(documentRef, "No ranked matches with a rank yet.");
    publish({ request: query.request, kind: "empty", points: 0 }, documentRef, locationRef);
    return { ok: true, points: 0 };
  }
  // Panorama can load the page before laying out its panel, so draw at the current size and redraw on resize.
  const draw = () => {
    const size = viewport();
    try {
      documentRef.body.innerHTML = buildChartSvg(grouped, ranks, { width: size.width || 1000, height: size.height || 140, current: points.at(-1)[1] });
    } catch {
      /* page is unloading */
    }
  };
  draw();
  resizeTarget?.addEventListener?.("resize", draw);
  publish({ request: query.request, kind: "ready", points: grouped.length }, documentRef, locationRef);
  return { ok: true, points: grouped.length };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  window.addEventListener?.("pagehide", () => controller?.abort(), { once: true });
  void runRankHistory({ signal: controller?.signal });
}

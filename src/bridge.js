import { ApiError, fetchCommunity, fetchMetadata } from "./api.js";
import {
  FRESH_TTL_MS,
  clearExpiredResults,
  readCommunityCache,
  readPlayerCache,
  readRateState,
  updateRateState,
  withResourceOwnership,
  writeCommunityCache,
  writePlayerCache,
} from "./cache.js";
import { aggregatePlayerPrefixes, composePlayerWithCommunity } from "./metrics.js";
import { DEFAULT_MATCHES, DEFAULT_MODE, buildErrorTitle, buildSuccessTitle, parseBridgeQuery, TITLE_MAX_LENGTH } from "./title-protocol.js";

const ERROR_MESSAGES = Object.freeze({
  invalid_query: "Invalid bridge request.",
  network_error: "The stats service could not be reached.",
  upstream_error: "The stats service returned an error.",
  rate_limit: "The stats service is rate limited.",
  empty_sample: "No matches were available.",
  invalid_payload: "The stats service returned invalid data.",
  payload_too_large: "The stats result was too large.",
  internal_error: "The stats bridge failed.",
});
const PLAYER_RATE_FAMILY = "metadata";
const COMMUNITY_RATE_FAMILY = "community";
const bridgePlayerInFlight = new Map();
const bridgeCommunityInFlight = new Map();

function defaultLocation() { return typeof globalThis.location === "undefined" ? null : globalThis.location; }
function defaultDocument() { return typeof globalThis.document === "undefined" ? null : globalThis.document; }
function defaultStorage() { try { return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage; } catch { return null; } }
function defaultNavigator() { return typeof globalThis.navigator === "undefined" ? null : globalThis.navigator; }
function clockValue(now) { const value = typeof now === "function" ? now() : now; return Number.isFinite(value) ? value : Date.now(); }
function safeIsoNow(now) { try { return new Date(clockValue(now)).toISOString(); } catch { return new Date(0).toISOString(); } }
function waitMs(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }


function isAbortError(error, signal) { return signal?.aborted === true || error?.name === "AbortError"; }

function genericError(error) {
  if (error instanceof ApiError && error.code === "payload_too_large") return { code: "payload_too_large", status: null, retryAfter: null };
  if (error instanceof ApiError) {
    const status = Number.isInteger(error.status) && error.status > 0 ? error.status : null;
    if (status === 429) return { code: "rate_limit", status, retryAfter: error.retryAfter };
    return { code: status === null ? "network_error" : "upstream_error", status, retryAfter: error.retryAfter };
  }
  return { code: "network_error", status: null, retryAfter: null };
}

function buildErrorForQuery(query, code, options = {}) {
  return buildErrorTitle({ request: query?.request, account: query?.account, matches: query?.matches ?? DEFAULT_MATCHES, mode: query?.mode ?? DEFAULT_MODE, code, status: options.status, retry_after: options.retryAfter, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error });
}

function publishTitle(title, { documentRef = defaultDocument(), locationRef = defaultLocation() } = {}) {
  if (!documentRef || typeof title !== "string" || title.length > TITLE_MAX_LENGTH) return false;
  try { documentRef.title = title; if (locationRef) locationRef.hash = encodeURIComponent(title); return true; } catch { return false; }
}

function emitError(query, code, options, deps) {
  let title;
  try { title = buildErrorForQuery(query, code, options); } catch { title = buildErrorTitle({ request: "", account: null, matches: DEFAULT_MATCHES, mode: DEFAULT_MODE, code: "internal_error", message: ERROR_MESSAGES.internal_error }); }
  publishTitle(title, deps);
  return { ok: false, title, code };
}


function freshEnough(cached, freshness = "fresh") {
  return Boolean(cached && cached.freshness === freshness && Number.isFinite(cached.ageMs) && cached.ageMs >= 0);
}

function cachedAnalysis(cached, matches) {
  return cached?.value?.samples?.[String(matches)] ?? null;
}


function cooldownError(family, state, now) {
  const retryAfter = Math.ceil(Math.max(0, (state?.blockedUntil ?? now) - now) / 1000);
  const error = new ApiError("Deadlock API request is rate limited", { status: 429, retryAfter, code: "rate_limit" });
  error.family = family;
  error.blockedUntil = state?.blockedUntil ?? now;
  return error;
}
async function waitForRateWindow(deps, family, now) {
  let state;
  try { state = deps.readRate(deps.storage, family, now); } catch { state = null; }
  if (state?.blockedUntil > now) throw cooldownError(family, state, now);
  const reset = Number(state?.lastBlockedUntil);
  const key = `${family}:${reset}`;
  if (reset > 0 && reset <= now && now - reset <= 60_000 && !deps.resumedCooldowns.has(key)) {
    deps.resumedCooldowns.add(key);
    const random = Number(deps.random());
    await deps.wait(Math.floor(Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0.5)) * 250));
  }
}


function validAnalysis(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Number.isSafeInteger(value.sampleSize) &&
    value.sampleSize >= 0 &&
    Array.isArray(value.metrics) &&
    value.metrics.length >= 12,
  );
}

function makeDeps(options) {
  return {
    location: options.location ?? defaultLocation(),
    documentRef: options.documentRef ?? defaultDocument(),
    storage: options.storage ?? defaultStorage(),
    navigatorRef: options.navigatorRef ?? defaultNavigator(),
    now: options.now ?? Date.now,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    wait: options.wait ?? waitMs,
    random: options.random ?? Math.random,
    fetchMetadata: options.fetchMetadata ?? fetchMetadata,
    fetchCommunity: options.fetchCommunity ?? fetchCommunity,
    clearCache: options.clearCache ?? clearExpiredResults,
    readPlayer: options.readPlayer ?? readPlayerCache,
    writePlayer: options.writePlayer ?? writePlayerCache,
    readCommunity: options.readCommunity ?? readCommunityCache,
    writeCommunity: options.writeCommunity ?? writeCommunityCache,
    readRate: options.readRate ?? readRateState,
    updateRate: options.updateRate ?? updateRateState,
    own: options.own ?? withResourceOwnership,
    resumedCooldowns: options.resumedCooldowns ?? new Set(),
  };
}
async function resolveCommunityResource(deps, query, now) {
  const scope = String(query.matches);
  let cached;
  try { cached = deps.readCommunity(deps.storage, query.mode, scope, now); } catch { cached = null; }
  if (freshEnough(cached, "fresh")) {
    return { cache: cached, value: cached.value, source: "cache", envelope: null };
  }

  const key = `${query.mode}:${scope}`;
  let promise = bridgeCommunityInFlight.get(key);
  if (!promise) {
    promise = (async () => {
      const ownership = await deps.own({
        resourceKey: `community:${key}`,
        storage: deps.storage,
        navigatorRef: deps.navigatorRef,
        signal: deps.signal,
        now: deps.now,
        run: async () => {
          let latest;
          try { latest = deps.readCommunity(deps.storage, query.mode, scope, clockValue(deps.now)); } catch { latest = null; }
          if (freshEnough(latest, "fresh")) {
            return { cache: latest, value: latest.value, source: "cache", envelope: null };
          }
          await waitForRateWindow(deps, COMMUNITY_RATE_FAMILY, clockValue(deps.now));
          let envelope;
          try {
            envelope = await deps.fetchCommunity({
              mode: query.mode,
              metricsLimit: query.matches,
              fetchImpl: deps.fetchImpl,
              signal: deps.signal,
            });
          } catch (error) {
            if (error instanceof ApiError) {
              try { deps.updateRate(deps.storage, COMMUNITY_RATE_FAMILY, error.headers, { now: clockValue(deps.now), status: error.status }); } catch { /* optional */ }
            }
            throw error;
          }
          try { deps.updateRate(deps.storage, COMMUNITY_RATE_FAMILY, envelope.headers, { now: clockValue(deps.now), status: envelope.status }); } catch { /* optional */ }
          const value = { mode: query.mode, scope, metrics: envelope.data?.metrics ?? envelope.data, fetchedAt: safeIsoNow(deps.now) };
          try { deps.writeCommunity(deps.storage, query.mode, scope, value, clockValue(deps.now)); } catch { /* optional */ }
          return { value, source: "network", envelope };
        },
      });
      if (ownership?.owned === false) {
        let afterWait;
        try { afterWait = deps.readCommunity(deps.storage, query.mode, scope, clockValue(deps.now)); } catch { afterWait = null; }
        if (freshEnough(afterWait, "fresh")) {
          return { cache: afterWait, value: afterWait.value, source: "cache", envelope: null };
        }
        throw new Error("Community request ownership expired without a cache result");
      }
      return ownership?.value ?? ownership;
    })().finally(() => bridgeCommunityInFlight.delete(key));
    bridgeCommunityInFlight.set(key, promise);
  }
  try {
    return await promise;
  } catch (error) {
    let fallback;
    try { fallback = deps.readCommunity(deps.storage, query.mode, scope, clockValue(deps.now)); } catch { fallback = null; }
    if (fallback) {
      return { cache: fallback, value: fallback.value, source: "stale", envelope: null, error };
    }
    throw error;
  }
}

function oldestGenerated(left, right, fallback) {
  const values = [left, right].map((value) => Date.parse(value)).filter(Number.isFinite);
  return values.length > 0 ? new Date(Math.min(...values)).toISOString() : fallback;
}


export async function runBridge(options = {}) {
  const deps = makeDeps(options);
  const query = parseBridgeQuery(deps.location?.search ?? "");
  const titleOptions = { documentRef: deps.documentRef, locationRef: deps.location };
  if (deps.signal?.aborted) return { ok: false, aborted: true };
  if (!query.ok) return emitError(query, "invalid_query", {}, titleOptions);
  const now = clockValue(deps.now);
  try { deps.clearCache?.(deps.storage, now); } catch { /* cleanup is opportunistic */ }
  if (deps.signal?.aborted) return { ok: false, aborted: true };

  let cachedPlayer;
  try { cachedPlayer = deps.readPlayer(deps.storage, query.account, query.mode, now); } catch { cachedPlayer = null; }
  const hasFreshPlayer = freshEnough(cachedPlayer, "fresh") && validAnalysis(cachedAnalysis(cachedPlayer, query.matches));
  const communityPromise = resolveCommunityResource(deps, query, now);
  let player;
  let playerError = null;
  if (hasFreshPlayer) {
    player = { cache: cachedPlayer, value: cachedPlayer.value, source: "cache", envelope: null };
  } else {
    const playerKey = `${query.account}:${query.mode}`;
    let promise = bridgePlayerInFlight.get(playerKey);
    if (!promise) {
      promise = (async () => {
        const ownership = await deps.own({
          resourceKey: `player:${playerKey}`,
          storage: deps.storage,
          navigatorRef: deps.navigatorRef,
          signal: deps.signal,
          now: deps.now,
          run: async () => {
          const latest = (() => { try { return deps.readPlayer(deps.storage, query.account, query.mode, clockValue(deps.now)); } catch { return null; } })();
          if (freshEnough(latest, "fresh") && validAnalysis(cachedAnalysis(latest, query.matches))) return { cache: latest, value: latest.value, source: "cache", envelope: null };
          await waitForRateWindow(deps, PLAYER_RATE_FAMILY, clockValue(deps.now));
          let metadata;
          try {
            metadata = await deps.fetchMetadata({ accountId: query.account, limit: 150, mode: query.mode, signal: deps.signal, fetchImpl: deps.fetchImpl });
          } catch (error) {
            if (error instanceof ApiError) {
              try { deps.updateRate(deps.storage, PLAYER_RATE_FAMILY, error.headers, { now: clockValue(deps.now), status: error.status }); } catch { /* optional */ }
            }
            throw error;
          }
          try { deps.updateRate(deps.storage, PLAYER_RATE_FAMILY, metadata.headers, { now: clockValue(deps.now), status: metadata.status }); } catch { /* optional */ }
          if (deps.signal?.aborted) { const error = new Error("The request was aborted"); error.name = "AbortError"; throw error; }
          const prefixes = aggregatePlayerPrefixes({ accountId: query.account, metadata: metadata.data, limits: [50, 100, 150] });
          const value = { ...prefixes, accountId: query.account, mode: query.mode, maxMatches: 150, fetchedAt: safeIsoNow(deps.now) };
          try { deps.writePlayer(deps.storage, query.account, query.mode, value, clockValue(deps.now)); } catch { /* optional */ }
          return { value, source: "network", envelope: { metadata } };
        } });
        if (ownership?.owned === false) {
          const afterWait = (() => { try { return deps.readPlayer(deps.storage, query.account, query.mode, clockValue(deps.now)); } catch { return null; } })();
          if (freshEnough(afterWait, "fresh") && validAnalysis(cachedAnalysis(afterWait, query.matches))) {
            return { cache: afterWait, value: afterWait.value, source: "cache", envelope: null };
          }
          throw new Error("Player request ownership expired without a fresh cache result");
        }
        return ownership?.value ?? ownership;
      })().finally(() => bridgePlayerInFlight.delete(playerKey));
      bridgePlayerInFlight.set(playerKey, promise);
    }
    try { player = await promise; } catch (error) { playerError = error; const fallback = (() => { try { return deps.readPlayer(deps.storage, query.account, query.mode, clockValue(deps.now)); } catch { return null; } })() ?? cachedPlayer; if (fallback && cachedAnalysis(fallback, query.matches)) player = { cache: fallback, value: fallback.value, source: "stale", envelope: null, error }; }
  }

  if (deps.signal?.aborted) return { ok: false, aborted: true };
  if (!player) {
    if (communityPromise) await Promise.allSettled([communityPromise]);
    const failure = genericError(playerError);
    return emitError(query, failure.code, failure, titleOptions);
  }

  let community = null;
  let communityError = null;
  if (communityPromise) {
    try {
      community = await communityPromise;
    } catch (error) {
      communityError = error;
    }
  }

  if (deps.signal?.aborted) return { ok: false, aborted: true };
  const playerAnalysis = cachedAnalysis(player, query.matches);
  const communityValue = community?.value?.metrics ? { metrics: community.value.metrics } : community?.value;
  const analysis = community ? composePlayerWithCommunity(playerAnalysis, communityValue) : playerAnalysis;
  if (!analysis || !Number.isSafeInteger(analysis.sampleSize)) return emitError(query, "invalid_payload", {}, titleOptions);
  if (analysis.sampleSize === 0) return emitError(query, "empty_sample", {}, titleOptions);
  let title;
  const stale = player.source === "stale" || community?.source === "stale";
  const generated = stale
    ? oldestGenerated(player.value?.fetchedAt, community?.value?.fetchedAt, safeIsoNow(deps.now))
    : player.value?.fetchedAt ?? safeIsoNow(deps.now);
  try { title = buildSuccessTitle({ request: query.request, account: query.account, matches: query.matches, mode: query.mode, sample: analysis.sampleSize, generated, analysis }); } catch (error) { return emitError(query, error?.name === "RangeError" ? "payload_too_large" : "invalid_payload", {}, titleOptions); }
  if (deps.signal?.aborted) return { ok: false, aborted: true };
  publishTitle(title, titleOptions);
  const source = stale
    ? "stale"
    : player.source === "network" || community?.source === "network"
      ? "network"
      : "cache";
  return { ok: true, source, title, playerError, communityError };
}

export function readFreshCache(storage, account, matches, mode, now) {
  try {
    const cached = readPlayerCache(storage, account, mode, now);
    return freshEnough(cached, "fresh") && validAnalysis(cachedAnalysis(cached, matches)) ? cached : null;
  } catch {
    return null;
  }
}
export { ERROR_MESSAGES, genericError, publishTitle };


export function startBridgePage({ windowRef = typeof globalThis.window === "undefined" ? null : globalThis.window, run = runBridge, AbortControllerImpl = globalThis.AbortController } = {}) {
  const controller = typeof AbortControllerImpl === "function" ? new AbortControllerImpl() : null;
  const onPageHide = () => controller?.abort();
  try { windowRef?.addEventListener?.("pagehide", onPageHide, { once: true }); } catch { /* lifecycle is optional */ }
  const promise = Promise.resolve().then(() => run({ signal: controller?.signal })).finally(() => { try { windowRef?.removeEventListener?.("pagehide", onPageHide); } catch { /* page may be gone */ } });
  return { controller, promise };
}

if (typeof window !== "undefined" && typeof document !== "undefined") void startBridgePage().promise;

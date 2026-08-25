const PLAYER_CACHE_PREFIX = "deadlock-stats-player:v1:";
const COMMUNITY_CACHE_PREFIX = "deadlock-stats-community:v1:";
const RATE_CACHE_PREFIX = "deadlock-stats-rate:v1:";
const RATE_BLOCK_PREFIX = "deadlock-stats-rate-block:v1:";
const OWNER_PREFIX = "deadlock-stats-owner:v1:";

const CACHE_MODES = new Set(["ranked", "standard"]);
const COMMUNITY_SCOPES = /^(?:all|\d+)$/;
const LEGACY_PREFIXES = [
  "deadlock-stats-cache:v2:",
  "deadlock-stats-cache:v3:",
  "deadlock-stats-bridge-cache:v1:",
  "deadlock-stats-compat:v1:",
  "deadlock-stats-bridge:v2:",
];

export const FRESH_TTL_MS = 10 * 60 * 1000;
export const COMMUNITY_FRESH_TTL_MS = 60 * 60 * 1000;
export const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_JITTER_WINDOW_MS = 60_000;
const MAX_RATE_BLOCK_MS = STALE_TTL_MS;
export const MAX_CACHE_ENTRIES = 64;
export const MAX_CACHE_SERIALIZED_BYTES = 1024 * 1024;

function defaultNow() {
  return Date.now();
}

function validMode(mode) {
  return typeof mode === "string" && CACHE_MODES.has(mode);
}

function validAccount(accountId) {
  return Number.isSafeInteger(accountId) && accountId > 0;
}

function validScope(scope) {
  return typeof scope === "string" && COMMUNITY_SCOPES.test(scope);
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function playerCacheKey(accountId, mode) {
  return `${PLAYER_CACHE_PREFIX}${encode(accountId)}:${encode(mode)}`;
}

function communityCacheKey(mode, scope) {
  return `${COMMUNITY_CACHE_PREFIX}${encode(mode)}:${encode(scope)}`;
}

function rateCacheKey(family) {
  return `${RATE_CACHE_PREFIX}${encode(family)}`;
}

function rateBlockKey(family, blockedUntil) {
  return `${RATE_BLOCK_PREFIX}${encode(family)}:${blockedUntil}:${makeOwnerToken()}`;
}


function storageKeys(storage) {
  if (!storage || typeof storage.key !== "function") return [];
  const keys = [];
  try {
    const length = Number.isFinite(storage.length) ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string") keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function isCacheKey(key) {
  return key.startsWith(PLAYER_CACHE_PREFIX) ||
    key.startsWith(COMMUNITY_CACHE_PREFIX) ||
    key.startsWith(RATE_CACHE_PREFIX) ||
    key.startsWith(RATE_BLOCK_PREFIX);
}

function parseJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function serializedBytes(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return Infinity;
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
  return text.length;
}

function timestampIsValid(entry, now) {
  if (!entry || !Number.isFinite(now) || !Number.isFinite(entry.savedAt)) return false;
  if (entry.savedAt > now) return false;
  if (entry.fetchedAt !== undefined) {
    if (typeof entry.fetchedAt === "number" && (!Number.isFinite(entry.fetchedAt) || entry.fetchedAt > now)) {
      return false;
    }
    if (typeof entry.fetchedAt === "string") {
      const fetchedAt = Date.parse(entry.fetchedAt);
      if (Number.isFinite(fetchedAt) && fetchedAt > now) return false;
    } else if (typeof entry.fetchedAt !== "number") {
      return false;
    }
  }
  return true;
}

function ageFor(entry, now) {
  return now - entry.savedAt;
}

function entryFreshness(entry, now, freshTtl = FRESH_TTL_MS) {
  if (!timestampIsValid(entry, now)) return null;
  const ageMs = ageFor(entry, now);
  if (ageMs < 0 || ageMs >= STALE_TTL_MS) return null;
  return { ageMs, freshness: ageMs < freshTtl ? "fresh" : "stale" };
}

function removeKey(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function purgeLegacyNamespaces(storage) {
  if (!storage || typeof storage.removeItem !== "function") return 0;
  let removed = 0;
  for (const key of storageKeys(storage)) {
    if (!LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (removeKey(storage, key)) removed += 1;
  }
  return removed;
}

function readRaw(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (typeof raw !== "string" || raw.length > MAX_CACHE_SERIALIZED_BYTES) return null;
    if (serializedBytes(raw) > MAX_CACHE_SERIALIZED_BYTES) return null;
    return parseJson(raw);
  } catch {
    return null;
  }
}

function cacheEntryValid(entry, now) {
  if (!entry || !timestampIsValid(entry, now)) return false;
  if (entry.kind === "rate-block") {
    return Number.isFinite(entry.blockedUntil) &&
      entry.blockedUntil > now - RATE_JITTER_WINDOW_MS &&
      entry.blockedUntil <= now + MAX_RATE_BLOCK_MS;
  }
  return ageFor(entry, now) < STALE_TTL_MS;
}

function removeExpiredEntries(storage, now) {
  let removed = 0;
  for (const key of storageKeys(storage)) {
    if (!isCacheKey(key)) continue;
    const entry = readRaw(storage, key);
    const valid = cacheEntryValid(entry, now);
    if (!valid && removeKey(storage, key)) removed += 1;
  }
  return removed;
}

export function clearExpiredResults(storage, now = defaultNow()) {
  if (!storage || !Number.isFinite(now)) return 0;
  return purgeLegacyNamespaces(storage) + removeExpiredEntries(storage, now);
}

function evictionCandidates(storage, now, excludedKey) {
  return storageKeys(storage)
    .filter((key) => isCacheKey(key) && key !== excludedKey)
    .map((key) => {
      const raw = (() => {
        try { return storage.getItem(key); } catch { return null; }
      })();
      const entry = parseJson(raw);
      return {
        key,
        entry,
        bytes: typeof raw === "string" ? serializedBytes(raw) : 0,
        lastUsedAt: Number.isFinite(entry?.lastUsedAt) ? entry.lastUsedAt : (entry?.savedAt ?? 0),
        valid: cacheEntryValid(entry, now),
      };
    })
    .filter((candidate) => !(candidate.entry?.kind === "rate-block" && candidate.entry.blockedUntil > now))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
}

function writeBounded(storage, key, entry, now) {
  if (!storage || typeof storage.setItem !== "function") return false;
  let serialized;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    return false;
  }
  const bytes = serializedBytes(serialized);
  if (!Number.isFinite(bytes) || bytes > MAX_CACHE_SERIALIZED_BYTES) return false;

  purgeLegacyNamespaces(storage);
  removeExpiredEntries(storage, now);
  const evictUntilFits = () => {
    let candidates = evictionCandidates(storage, now, key);
    let total = storageKeys(storage)
      .filter((candidate) => isCacheKey(candidate) && candidate !== key)
      .reduce((sum, candidate) => {
        try { return sum + serializedBytes(storage.getItem(candidate) ?? ""); } catch { return sum; }
      }, 0);
    while (candidates.length > 0 && (
      storageKeys(storage).filter((candidate) => isCacheKey(candidate) && candidate !== key).length + 1 > MAX_CACHE_ENTRIES ||
      total + bytes > MAX_CACHE_SERIALIZED_BYTES
    )) {
      const candidate = candidates.shift();
      if (removeKey(storage, candidate.key)) total -= candidate.bytes;
    }
  };

  evictUntilFits();
  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    // Quota implementations can reject a write even after size accounting. Evict
    // the oldest valid entries once and retry the one write.
    const candidates = evictionCandidates(storage, now, key);
    for (const candidate of candidates) {
      if (!candidate.valid || !removeKey(storage, candidate.key)) continue;
      try {
        storage.setItem(key, serialized);
        return true;
      } catch {
        // Continue removing only as much as needed for one bounded retry.
      }
    }
    return false;
  }
}

function compactMetric(metric) {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) return null;
  const result = {};
  for (const key of ["id", "label", "value", "displayValue", "communityValue", "communityDisplayValue", "unit"]) {
    if (Object.prototype.hasOwnProperty.call(metric, key)) result[key] = metric[key];
  }
  return result;
}

function compactAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value.analysis && typeof value.analysis === "object" ? value.analysis : value;
  const compact = {
    sampleSize: analysis.sampleSize,
    totalDurationSeconds: analysis.totalDurationSeconds,
    metrics: Array.isArray(analysis.metrics) ? analysis.metrics.map(compactMetric).filter(Boolean) : [],
    supplemental: analysis.supplemental && typeof analysis.supplemental === "object" ? analysis.supplemental : {},
  };
  if (!Number.isSafeInteger(compact.sampleSize) || compact.sampleSize < 0) return null;
  return compact;
}

function compactPlayerValue(value, accountId, mode, now) {
  if (!value || typeof value !== "object" || !validAccount(accountId) || !validMode(mode)) return null;
  const samples = {};
  if (value.samples && typeof value.samples === "object" && !Array.isArray(value.samples)) {
    for (const [key, sample] of Object.entries(value.samples)) {
      if (!/^\d+$/.test(key)) continue;
      const compact = compactAnalysis(sample);
      if (compact) samples[String(Number(key))] = compact;
    }
  } else if (value.analysis) {
    const key = Number.isSafeInteger(value.maxMatches) ? value.maxMatches : null;
    const compact = compactAnalysis(value.analysis);
    if (key && compact) samples[String(key)] = compact;
  }
  const maxMatches = Number.isSafeInteger(value.maxMatches)
    ? value.maxMatches
    : Math.max(0, ...Object.keys(samples).map(Number));
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || Object.keys(samples).length === 0) return null;
  return {
    accountId,
    mode,
    maxMatches,
    fetchedAt: value.fetchedAt ?? new Date(now).toISOString(),
    samples,
  };
}

function communityMetricMap(value) {
  const source = value?.metrics && typeof value.metrics === "object"
    ? value.metrics
    : value?.data?.metrics && typeof value.data.metrics === "object"
      ? value.data.metrics
      : value?.data && typeof value.data === "object" && !Array.isArray(value.data)
        ? value.data
        : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const metrics = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const avg = Number(entry.avg);
    if (!Number.isFinite(avg)) continue;
    metrics[key] = { avg };
  }
  return Object.keys(metrics).length ? metrics : null;
}

function compactCommunityValue(value, mode, scope, now) {
  if (!validMode(mode) || !validScope(scope)) return null;
  const metrics = communityMetricMap(value);
  if (!metrics) return null;
  return {
    mode,
    scope,
    fetchedAt: value?.fetchedAt ?? new Date(now).toISOString(),
    metrics,
  };
}

function readResource(storage, key, now, freshTtl, expected) {
  if (!storage || typeof storage.getItem !== "function") return null;
  const entry = readRaw(storage, key);
  if (!entry || entry.kind !== expected) return null;
  const freshness = entryFreshness(entry, now, freshTtl);
  if (!freshness) return null;
  try {
    entry.lastUsedAt = now;
    storage.setItem(key, JSON.stringify(entry));
  } catch {
    // LRU touches are opportunistic and must not turn a cache hit into a miss.
  }
  const value = entry.value ?? (expected === "player"
    ? { accountId: entry.accountId, mode: entry.mode, maxMatches: entry.maxMatches, fetchedAt: entry.fetchedAt, samples: entry.samples }
    : expected === "community"
      ? { mode: entry.mode, scope: entry.scope, fetchedAt: entry.fetchedAt, metrics: entry.metrics }
      : null);
  return { value, ageMs: freshness.ageMs, freshness: freshness.freshness, savedAt: entry.savedAt };
}

export function readPlayerCache(storage, accountId, mode = "ranked", now = defaultNow()) {
  if (!validAccount(accountId) || !validMode(mode)) return null;
  const result = readResource(storage, playerCacheKey(accountId, mode), now, FRESH_TTL_MS, "player");
  if (!result || result.value?.accountId !== accountId || result.value?.mode !== mode) return null;
  return result;
}

export function writePlayerCache(storage, accountId, mode, value, now = defaultNow()) {
  if (!Number.isFinite(now)) return false;
  const compact = compactPlayerValue(value, accountId, mode, now);
  if (!compact) return false;
  return writeBounded(storage, playerCacheKey(accountId, mode), {
    kind: "player",
    savedAt: now,
    lastUsedAt: now,
    ...compact,
  }, now);
}

export function readCommunityCache(storage, mode, scope, now = defaultNow()) {
  if (!validMode(mode) || !validScope(scope)) return null;
  const result = readResource(storage, communityCacheKey(mode, scope), now, COMMUNITY_FRESH_TTL_MS, "community");
  if (!result || result.value?.mode !== mode || result.value?.scope !== scope) return null;
  return result;
}

export function writeCommunityCache(storage, mode, scope, value, now = defaultNow()) {
  if (!Number.isFinite(now)) return false;
  const compact = compactCommunityValue(value, mode, scope, now);
  if (!compact) return false;
  return writeBounded(storage, communityCacheKey(mode, scope), {
    kind: "community",
    savedAt: now,
    lastUsedAt: now,
    ...compact,
  }, now);
}

function normalizedHeaderMap(headers) {
  const result = {};
  if (!headers) return result;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => { result[String(key).toLowerCase()] = String(value); });
  } else if (typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) result[String(key).toLowerCase()] = String(value);
  } else if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) result[String(key).toLowerCase()] = String(value);
    }
  }
  return result;
}

function headerNumber(headers, names) {
  for (const name of names) {
    const value = Number(headers[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function resetDelayMs(value, now) {
  if (!Number.isFinite(value) || value < 0) return 0;
  // APIs normally expose a duration in seconds. Accommodate epoch seconds too.
  if (value > 1_000_000_000) return Math.max(0, value * 1000 - now);
  return value * 1000;
}

export function readRateState(storage, family, now = defaultNow()) {
  if (!storage || typeof family !== "string" || !family || !Number.isFinite(now)) return null;
  const stored = readRaw(storage, rateCacheKey(family));
  const state = stored && Number.isFinite(stored.observedAt) && stored.observedAt <= now ? stored : null;
  let lastBlockedUntil = state && Number.isFinite(state.blockedUntil) &&
    state.blockedUntil <= now + MAX_RATE_BLOCK_MS
    ? state.blockedUntil
    : 0;
  let observedAt = state?.observedAt ?? 0;
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(RATE_BLOCK_PREFIX)) continue;
    const block = readRaw(storage, key);
    if (!block || block.kind !== "rate-block" || block.family !== family ||
      !cacheEntryValid(block, now)) {
      continue;
    }
    lastBlockedUntil = Math.max(lastBlockedUntil, block.blockedUntil);
    observedAt = Math.max(observedAt, block.savedAt);
  }
  if (!state && lastBlockedUntil === 0) return null;
  return {
    blockedUntil: lastBlockedUntil > now ? lastBlockedUntil : 0,
    lastBlockedUntil,
    limit: Number.isFinite(state?.limit) ? state.limit : null,
    period: Number.isFinite(state?.period) ? state.period : null,
    remaining: Number.isFinite(state?.remaining) ? state.remaining : null,
    observedAt,
  };
}

export function writeRateState(storage, family, state, now = defaultNow()) {
  if (!storage || typeof family !== "string" || !family || !state || !Number.isFinite(now)) return false;
  const blockedUntil = Number.isFinite(state.blockedUntil)
    ? Math.min(now + MAX_RATE_BLOCK_MS, Math.max(0, state.blockedUntil))
    : 0;
  let blockWritten = false;
  if (blockedUntil > now) {
    blockWritten = writeBounded(storage, rateBlockKey(family, blockedUntil), {
      kind: "rate-block",
      family,
      blockedUntil,
      savedAt: now,
      lastUsedAt: now,
    }, now);
  }
  const normalized = {
    blockedUntil: 0,
    limit: Number.isFinite(state.limit) ? state.limit : null,
    period: Number.isFinite(state.period) ? state.period : null,
    remaining: Number.isFinite(state.remaining) ? state.remaining : null,
    observedAt: now,
  };
  const stateWritten = writeBounded(storage, rateCacheKey(family), {
    kind: "rate",
    savedAt: now,
    lastUsedAt: now,
    value: normalized,
    ...normalized,
  }, now);
  return blockWritten || stateWritten;
}

export function updateRateState(storage, family, headers, {
  now = defaultNow(),
  status = 200,
} = {}) {
  if (!Number.isFinite(now)) return null;
  const previous = readRateState(storage, family, now);
  const normalized = normalizedHeaderMap(headers);
  const limit = headerNumber(normalized, ["ratelimit-limit", "x-ratelimit-limit"]);
  const period = headerNumber(normalized, ["ratelimit-period", "x-ratelimit-period"]);
  const remaining = headerNumber(normalized, ["ratelimit-remaining", "x-ratelimit-remaining"]);
  const reset = headerNumber(normalized, ["ratelimit-reset", "x-ratelimit-reset"]);
  const retryAfter = headerNumber(normalized, ["retry-after"]);
  const resetMs = reset === null ? 0 : resetDelayMs(reset, now);
  const retryMs = retryAfter === null ? 0 : resetDelayMs(retryAfter, now);
  const blockedDelay = status === 429
    ? Math.max(resetMs, retryMs)
    : remaining === 0
      ? resetMs
      : 0;
  const candidateBlockedUntil = blockedDelay > 0 ? now + blockedDelay : 0;
  const state = {
    blockedUntil: Math.max(previous?.blockedUntil ?? 0, candidateBlockedUntil),
    limit: limit ?? previous?.limit ?? null,
    period: period ?? previous?.period ?? null,
    remaining: remaining ?? previous?.remaining ?? null,
    observedAt: now,
  };
  writeRateState(storage, family, {
    ...state,
    blockedUntil: candidateBlockedUntil,
  }, now);
  return state;
}

export function rateCooldownRemaining(storage, family, now = defaultNow()) {
  const state = readRateState(storage, family, now);
  return state ? Math.max(0, state.blockedUntil - now) : 0;
}


function ownerKey(resourceKey) {
  return `${OWNER_PREFIX}${encode(resourceKey)}`;
}

function makeOwnerToken() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to the timestamp/random token for older embedded browsers.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ownershipAbortError() {
  const error = new Error("The resource request was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfOwnershipAborted(signal) {
  if (signal?.aborted) throw ownershipAbortError();
}

function waitForOwnership(milliseconds, signal) {
  if (typeof signal?.addEventListener !== "function") return waitMs(milliseconds);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(ownershipAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clockNow(clock) {
  const value = typeof clock === "function" ? clock() : clock;
  return Number.isFinite(value) ? value : Date.now();
}

/**
 * Run one resource producer across pages. Web Locks provide the strict path.
 * The storage lease is a bounded fallback for embedded browsers without Web
 * Locks; a short confirmation delay prevents simultaneous writers from both
 * treating their first write as ownership.
 */
export async function withResourceOwnership({
  resourceKey,
  storage,
  navigatorRef = typeof globalThis.navigator === "undefined" ? null : globalThis.navigator,
  signal,
  now = defaultNow,
  run,
  leaseMs = 30_000,
  timeoutMs = 31_000,
  waitMs: waitDuration = 40,
} = {}) {
  throwIfOwnershipAborted(signal);
  if (typeof run !== "function") throw new TypeError("run must be a function");
  const lockName = ownerKey(resourceKey ?? "resource");
  const acquisitionTimeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 31_000;
  const leaseDuration = Number.isFinite(leaseMs) ? Math.max(1, leaseMs) : 30_000;
  if (navigatorRef?.locks && typeof navigatorRef.locks.request === "function") {
    if (typeof AbortController !== "function") {
      const result = signal
        ? await navigatorRef.locks.request(lockName, { signal }, run)
        : await navigatorRef.locks.request(lockName, run);
      return { owned: true, value: result };
    }
    const controller = new AbortController();
    let parentAborted = false;
    const abortFromParent = () => {
      parentAborted = true;
      controller.abort();
    };
    signal?.addEventListener?.("abort", abortFromParent, { once: true });
    let acquired = false;
    let timer = setTimeout(() => controller.abort(), acquisitionTimeout);
    try {
      const result = await navigatorRef.locks.request(lockName, { signal: controller.signal }, async () => {
        acquired = true;
        clearTimeout(timer);
        timer = null;
        return run();
      });
      return { owned: true, value: result };
    } catch (error) {
      if (parentAborted) throw ownershipAbortError();
      if (!acquired && controller.signal.aborted) return { owned: false, value: null };
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortFromParent);
    }
  }

  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return { owned: true, value: await run() };
  }

  const token = makeOwnerToken();
  const key = ownerKey(resourceKey ?? "resource");
  const start = clockNow(now);
  const deadline = Number.isFinite(start) ? start + acquisitionTimeout : Date.now() + acquisitionTimeout;
  while (true) {
    throwIfOwnershipAborted(signal);
    let current = readRaw(storage, key);
    const currentNow = clockNow(now);
    const plausibleOwner = typeof current?.owner === "string" &&
      current.owner.length > 0 && current.owner.length <= 128 &&
      Number.isFinite(current.expiresAt) &&
      current.expiresAt <= currentNow + leaseDuration + 1_000;
    if (current && !plausibleOwner) {
      removeKey(storage, key);
      current = null;
    }
    const available = !current || current.expiresAt <= currentNow;
    if (available) {
      const lease = { owner: token, expiresAt: currentNow + leaseDuration };
      let confirmed;
      try {
        storage.setItem(key, JSON.stringify(lease));
        await waitForOwnership(Math.max(1, Math.min(waitDuration, 40)), signal);
        confirmed = readRaw(storage, key);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return { owned: true, value: await run() };
      }
      if (confirmed?.owner === token) {
        const renewalMs = Math.max(1, Math.floor(leaseDuration / 2));
        const renewal = setInterval(() => {
          const stillOwner = readRaw(storage, key);
          if (stillOwner?.owner !== token) return;
          try {
            storage.setItem(key, JSON.stringify({
              owner: token,
              expiresAt: clockNow(now) + leaseDuration,
            }));
          } catch {
            // The lease remains valid until its current expiry.
          }
        }, renewalMs);
        try {
          throwIfOwnershipAborted(signal);
          return { owned: true, value: await run() };
        } finally {
          clearInterval(renewal);
          const stillOwner = readRaw(storage, key);
          if (stillOwner?.owner === token) removeKey(storage, key);
        }
      }
    }
    if (currentNow >= deadline) return { owned: false, value: null };
    await waitForOwnership(Math.max(1, waitDuration), signal);
  }
}

export {
  COMMUNITY_CACHE_PREFIX,
  PLAYER_CACHE_PREFIX,
  RATE_CACHE_PREFIX,
};

const CACHE_PREFIX = "deadlock-stats-cache:v3:";
const DEFAULT_CACHE_MODE = "ranked";
const CACHE_MODES = new Set(["ranked", "standard"]);
const BRIDGE_CACHE_PREFIX = "deadlock-stats-bridge-cache:v1:";
const BRIDGE_CACHE_MAX_ENTRIES = 24;

export const FRESH_TTL_MS = 10 * 60 * 1000;
export const STALE_TTL_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_CACHE_ENTRY_MAX_CHARS = 32 * 1024;

function cacheKey(accountId, matches, mode) {
  return `${CACHE_PREFIX}${encodeURIComponent(String(accountId))}:${encodeURIComponent(String(matches))}:${encodeURIComponent(mode)}`;
}

function bridgeCacheKey(accountId, matches, mode) {
  return `${BRIDGE_CACHE_PREFIX}${encodeURIComponent(String(accountId))}:${encodeURIComponent(String(matches))}:${encodeURIComponent(mode)}`;
}

function validCacheIdentity(accountId, matches, mode) {
  return (
    Number.isSafeInteger(accountId) &&
    accountId > 0 &&
    Number.isSafeInteger(matches) &&
    matches > 0 &&
    CACHE_MODES.has(mode)
  );
}

function defaultNow() {
  return Date.now();
}

function parseEntry(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object") return null;
    if (!Number.isFinite(entry.savedAt)) return null;
    if (!("value" in entry)) return null;
    return entry;
  } catch {
    return null;
  }
}

function parseBridgeEntry(raw) {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > BRIDGE_CACHE_ENTRY_MAX_CHARS
  ) {
    return null;
  }
  try {
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (
      Object.keys(entry).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(entry, "savedAt") ||
      !Object.prototype.hasOwnProperty.call(entry, "value") ||
      !Number.isFinite(entry.savedAt) ||
      !entry.value ||
      typeof entry.value !== "object" ||
      Array.isArray(entry.value)
    ) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function bridgeKeys(storage) {
  const keys = [];
  try {
    const length = Number.isFinite(storage?.length) ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(BRIDGE_CACHE_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    return [];
  }
  return keys;
}

function resolveReadArgs(modeOrNow, maybeNow) {
  if (typeof modeOrNow === "string") {
    return {
      mode: modeOrNow,
      now: maybeNow === undefined ? defaultNow() : maybeNow,
    };
  }
  return {
    mode: DEFAULT_CACHE_MODE,
    now: modeOrNow === undefined ? defaultNow() : modeOrNow,
  };
}

function resolveWriteArgs(modeOrValue, maybeValue, hasExplicitMode) {
  return hasExplicitMode
    ? { mode: modeOrValue, value: maybeValue }
    : { mode: DEFAULT_CACHE_MODE, value: modeOrValue };
}

export function readCachedResult(
  storage,
  accountId,
  matches,
  modeOrNow,
  maybeNow,
) {
  const { mode, now } = resolveReadArgs(modeOrNow, maybeNow);
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    !validCacheIdentity(accountId, matches, mode)
  ) {
    return null;
  }

  let entry;
  try {
    entry = parseEntry(storage.getItem(cacheKey(accountId, matches, mode)));
  } catch {
    return null;
  }
  if (!entry || !Number.isFinite(now)) return null;

  const rawAge = now - entry.savedAt;
  const ageMs = Math.max(0, rawAge);
  if (ageMs >= STALE_TTL_MS) return null;

  return {
    value: entry.value,
    ageMs,
    freshness: ageMs < FRESH_TTL_MS ? "fresh" : "stale",
  };
}

export function writeCachedResult(
  storage,
  accountId,
  matches,
  modeOrValue,
  maybeValue,
) {
  const { mode, value } = resolveWriteArgs(
    modeOrValue,
    maybeValue,
    arguments.length >= 5,
  );
  if (
    !storage ||
    typeof storage.setItem !== "function" ||
    !validCacheIdentity(accountId, matches, mode)
  ) {
    return false;
  }
  try {
    const serialized = JSON.stringify({ savedAt: Date.now(), value });
    storage.setItem(cacheKey(accountId, matches, mode), serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearExpiredResults(storage, now = defaultNow()) {
  if (
    !storage ||
    typeof storage.key !== "function" ||
    typeof storage.removeItem !== "function" ||
    !Number.isFinite(now)
  ) {
    return 0;
  }

  let keys = [];
  try {
    const length = Number.isFinite(storage.length) ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(CACHE_PREFIX)) keys.push(key);
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of keys) {
    let entry;
    try {
      entry = parseEntry(storage.getItem(key));
    } catch {
      entry = null;
    }
    const ageMs = entry ? Math.max(0, now - entry.savedAt) : STALE_TTL_MS;
    if (!entry || ageMs >= STALE_TTL_MS) {
      try {
        storage.removeItem(key);
        removed += 1;
      } catch {
        // A storage backend can become unavailable between enumeration and removal.
      }
    }
  }
  return removed;
}

export function readBridgeCachedResult(
  storage,
  accountId,
  matches,
  mode,
  now = defaultNow(),
) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    !validCacheIdentity(accountId, matches, mode) ||
    !Number.isFinite(now)
  ) {
    return null;
  }
  let entry;
  try {
    entry = parseBridgeEntry(storage.getItem(bridgeCacheKey(accountId, matches, mode)));
  } catch {
    return null;
  }
  if (!entry) return null;
  const ageMs = now - entry.savedAt;
  if (ageMs < 0 || ageMs >= FRESH_TTL_MS) return null;
  return { value: entry.value, ageMs, freshness: "fresh" };
}

export function clearExpiredBridgeResults(storage, now = defaultNow()) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.removeItem !== "function" ||
    !Number.isFinite(now)
  ) {
    return 0;
  }
  let removed = 0;
  for (const key of bridgeKeys(storage)) {
    let entry;
    try {
      entry = parseBridgeEntry(storage.getItem(key));
    } catch {
      entry = null;
    }
    const ageMs = entry ? now - entry.savedAt : FRESH_TTL_MS;
    if (!entry || ageMs < 0 || ageMs >= FRESH_TTL_MS) {
      try {
        storage.removeItem(key);
        removed += 1;
      } catch {
        // Storage can become unavailable between enumeration and removal.
      }
    }
  }
  return removed;
}

export function writeBridgeCachedResult(
  storage,
  accountId,
  matches,
  mode,
  value,
  now = defaultNow(),
) {
  if (
    !storage ||
    typeof storage.setItem !== "function" ||
    !validCacheIdentity(accountId, matches, mode) ||
    !Number.isFinite(now) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const key = bridgeCacheKey(accountId, matches, mode);
  let serialized;
  try {
    serialized = JSON.stringify({ savedAt: now, value });
  } catch {
    return false;
  }
  if (serialized.length > BRIDGE_CACHE_ENTRY_MAX_CHARS) return false;

  clearExpiredBridgeResults(storage, now);
  const existing = bridgeKeys(storage)
    .filter((candidate) => candidate !== key)
    .map((candidate) => {
      let entry;
      try {
        entry = parseBridgeEntry(storage.getItem(candidate));
      } catch {
        entry = null;
      }
      return { key: candidate, savedAt: entry?.savedAt ?? 0 };
    })
    .sort((left, right) => left.savedAt - right.savedAt);
  while (existing.length >= BRIDGE_CACHE_MAX_ENTRIES) {
    const oldest = existing.shift();
    try {
      storage.removeItem(oldest.key);
    } catch {
      break;
    }
  }
  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

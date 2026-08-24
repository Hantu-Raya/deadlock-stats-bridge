const CACHE_PREFIX = "deadlock-stats-cache:v2:";

export const FRESH_TTL_MS = 10 * 60 * 1000;
export const STALE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(accountId, limit) {
  return `${CACHE_PREFIX}${encodeURIComponent(String(accountId))}:${encodeURIComponent(String(limit))}`;
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

export function readCachedResult(storage, accountId, limit, now = defaultNow()) {
  if (!storage || typeof storage.getItem !== "function") return null;

  let entry;
  try {
    entry = parseEntry(storage.getItem(cacheKey(accountId, limit)));
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

export function writeCachedResult(storage, accountId, limit, value) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    const serialized = JSON.stringify({ savedAt: Date.now(), value });
    storage.setItem(cacheKey(accountId, limit), serialized);
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

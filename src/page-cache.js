// Small localStorage cache shared by the one-shot Panorama display pages. Storage is optional.

export function readCache(storage, key, ttl, now) {
  try {
    const entry = JSON.parse(storage?.getItem(key) ?? "null");
    return entry && Number.isFinite(entry.t) && now - entry.t >= 0 && now - entry.t < ttl ? entry.value : null;
  } catch {
    return null;
  }
}

/** Writes `value`; when `bound` is given, keeps at most `bound.max` entries under `bound.prefix` (oldest dropped). */
export function writeCache(storage, key, value, now, bound = null) {
  if (!storage) return;
  try {
    if (bound) {
      const aged = [];
      for (let index = 0; index < storage.length; index += 1) {
        const other = storage.key(index);
        if (!other || other === key || !other.startsWith(bound.prefix)) continue;
        let time = 0;
        try { time = JSON.parse(storage.getItem(other)).t || 0; } catch { time = 0; }
        aged.push([other, time]);
      }
      aged.sort((a, b) => a[1] - b[1]);
      while (aged.length >= bound.max) storage.removeItem(aged.shift()[0]);
    }
    storage.setItem(key, JSON.stringify({ t: now, value }));
  } catch {
    /* storage is optional */
  }
}

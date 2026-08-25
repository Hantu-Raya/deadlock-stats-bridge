import { ApiError, fetchDeadlockData } from "./api.js";
import {
  FRESH_TTL_MS,
  clearExpiredBridgeResults,
  readBridgeCachedResult,
  writeBridgeCachedResult,
} from "./cache.js";
import { analyzePlayer } from "./metrics.js";
import {
  DEFAULT_MATCHES,
  DEFAULT_MODE,
  buildErrorTitle,
  buildSuccessTitle,
  parseBridgeQuery,
  TITLE_MAX_LENGTH,
} from "./title-protocol.js";

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

function defaultLocation() {
  return typeof globalThis.location === "undefined" ? null : globalThis.location;
}

function defaultDocument() {
  return typeof globalThis.document === "undefined" ? null : globalThis.document;
}

function defaultStorage() {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function defaultNow() {
  return Date.now();
}

function safeIsoNow(now) {
  let value;
  try {
    value = typeof now === "function" ? now() : now;
    if (!Number.isFinite(value)) value = Date.now();
    return new Date(value).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function readFreshCache(
  storage,
  account,
  matches,
  mode,
  now,
  readCache = readBridgeCachedResult,
) {
  if (!storage || typeof readCache !== "function") return null;
  let cached;
  try {
    cached = readCache(storage, account, matches, mode, now);
  } catch {
    return null;
  }
  return (
    cached?.freshness === "fresh" &&
    Number.isFinite(cached.ageMs) &&
    cached.ageMs >= 0 &&
    cached.ageMs < FRESH_TTL_MS
  )
    ? cached
    : null;
}

function cachedAnalysis(cached) {
  const value = cached?.value;
  if (!value || typeof value !== "object") return null;
  return value.analysis && typeof value.analysis === "object"
    ? value.analysis
    : null;
}

function cachedGenerated(cached, now) {
  const generated = cached?.value?.fetchedAt;
  return typeof generated === "string" && generated.length > 0
    ? generated
    : safeIsoNow(now);
}

function responseGenerated(response, now) {
  return typeof response?.fetchedAt === "string" && response.fetchedAt.length > 0
    ? response.fetchedAt
    : safeIsoNow(now);
}

function isEmptyAnalysis(analysis) {
  return (
    analysis &&
    Number.isSafeInteger(analysis.sampleSize) &&
    analysis.sampleSize === 0
  );
}

function genericError(error) {
  if (error instanceof ApiError && error.code === "payload_too_large") {
    return { code: "payload_too_large", status: null, retryAfter: null };
  }
  if (error instanceof ApiError) {
    const status = Number.isInteger(error.status) && error.status > 0 ? error.status : null;
    const retryAfter = error.retryAfter ?? null;
    if (status === 429) {
      return { code: "rate_limit", status, retryAfter };
    }
    if (status === null) {
      return { code: "network_error", status: null, retryAfter: null };
    }
    return { code: "upstream_error", status, retryAfter };
  }
  return { code: "network_error", status: null, retryAfter: null };
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

function buildErrorForQuery(query, code, options = {}) {
  return buildErrorTitle({
    request: query?.request,
    account: query?.account,
    matches: query?.matches ?? DEFAULT_MATCHES,
    mode: query?.mode ?? DEFAULT_MODE,
    code,
    status: options.status,
    retry_after: options.retryAfter,
    message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error,
  });
}

function publishTitle(title, {
  documentRef = defaultDocument(),
  locationRef = defaultLocation(),
} = {}) {
  if (!documentRef || typeof title !== "string" || title.length > TITLE_MAX_LENGTH) return false;

  try {
    documentRef.title = title;
    if (locationRef) {
      locationRef.hash = encodeURIComponent(title);
    }
    return true;
  } catch {
    return false;
  }
}

function emitError(query, code, options, deps) {
  let title;
  try {
    title = buildErrorForQuery(query, code, options);
  } catch {
    title = buildErrorTitle({
      request: "",
      account: null,
      matches: DEFAULT_MATCHES,
      mode: DEFAULT_MODE,
      code: "internal_error",
      message: ERROR_MESSAGES.internal_error,
    });
  }
  publishTitle(title, deps);
  return { ok: false, title, code };
}

export async function runBridge({
  location = defaultLocation(),
  documentRef = defaultDocument(),
  storage = defaultStorage(),
  now = defaultNow,
  signal,
  fetchImpl,
  apiFetch = fetchDeadlockData,
  analyze = analyzePlayer,
  readCache = readBridgeCachedResult,
  writeCache = writeBridgeCachedResult,
  clearCache = clearExpiredBridgeResults,
} = {}) {
  const query = parseBridgeQuery(location?.search ?? "");
  const titleOptions = { documentRef, locationRef: location };
  if (signal?.aborted) {
    return { ok: false, aborted: true };
  }
  if (!query.ok) {
    return emitError(query, "invalid_query", {}, titleOptions);
  }

  const currentTime = typeof now === "function" ? now() : now;
  try {
    clearCache?.(storage, currentTime);
  } catch {
    // Cache cleanup is optional and must not block a live request.
  }
  const fresh = readFreshCache(
    storage,
    query.account,
    query.matches,
    query.mode,
    currentTime,
    readCache,
  );
  if (signal?.aborted) {
    return { ok: false, aborted: true };
  }
  if (fresh) {
    const analysis = cachedAnalysis(fresh);
    if (analysis && !isEmptyAnalysis(analysis)) {
      try {
        const title = buildSuccessTitle({
          request: query.request,
          account: query.account,
          matches: query.matches,
          mode: query.mode,
          sample: analysis.sampleSize,
          generated: cachedGenerated(fresh, now),
          analysis,
        });
        publishTitle(title, titleOptions);
        return { ok: true, source: "cache", title };
      } catch {
        // A malformed fresh entry is not a bridge result; fetch a clean value.
      }
    }
  }

  let response;
  try {
    response = await apiFetch({
      accountId: query.account,
      limit: query.matches,
      metricsLimit: query.matches,
      mode: query.mode,
      fetchImpl,
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      return { ok: false, aborted: true };
    }
    const failure = genericError(error);
    return emitError(query, failure.code, failure, titleOptions);
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true };
  }

  let analysis;
  try {
    analysis = analyze({
      accountId: query.account,
      metadata: response?.metadata,
      community: response?.community,
    });
  } catch (error) {
    return emitError(
      query,
      error instanceof RangeError ? "payload_too_large" : "invalid_payload",
      {},
      titleOptions,
    );
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true };
  }
  if (!analysis || !Number.isSafeInteger(analysis.sampleSize)) {
    return emitError(query, "invalid_payload", {}, titleOptions);
  }
  if (isEmptyAnalysis(analysis)) {
    return emitError(query, "empty_sample", {}, titleOptions);
  }

  const value = {
    analysis,
    fetchedAt: responseGenerated(response, now),
  };

  let title;
  try {
    title = buildSuccessTitle({
      request: query.request,
      account: query.account,
      matches: query.matches,
      mode: query.mode,
      sample: analysis.sampleSize,
      generated: value.fetchedAt,
      analysis,
    });
  } catch (error) {
    const code = error?.name === "RangeError" ? "payload_too_large" : "invalid_payload";
    return emitError(query, code, {}, titleOptions);
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true };
  }
  try {
    writeCache?.(storage, query.account, query.matches, query.mode, value, currentTime);
  } catch {
    // Cache persistence is opportunistic; a successful request still emits.
  }

  publishTitle(title, titleOptions);
  return { ok: true, source: "network", title };
}

export {
  ERROR_MESSAGES,
  genericError,
  publishTitle,
  readFreshCache,
};

export function startBridgePage({
  windowRef = typeof globalThis.window === "undefined" ? null : globalThis.window,
  run = runBridge,
  AbortControllerImpl = globalThis.AbortController,
} = {}) {
  const controller = typeof AbortControllerImpl === "function"
    ? new AbortControllerImpl()
    : null;
  const onPageHide = () => controller?.abort();
  try {
    windowRef?.addEventListener?.("pagehide", onPageHide, { once: true });
  } catch {
    // A missing page lifecycle event still leaves normal fetch cancellation.
  }
  const promise = Promise.resolve()
    .then(() => run({ signal: controller?.signal }))
    .finally(() => {
      try {
        windowRef?.removeEventListener?.("pagehide", onPageHide);
      } catch {
        // The page can disappear before listener cleanup.
      }
    });
  return { controller, promise };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void startBridgePage().promise;
}

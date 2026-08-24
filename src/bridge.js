import { ApiError, fetchDeadlockData } from "./api.js";
import {
  FRESH_TTL_MS,
  readCachedResult,
  writeCachedResult,
} from "./cache.js";
import { analyzePlayer } from "./metrics.js";
import {
  BRIDGE_MATCHES,
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
  empty_sample: "No ranked matches were available.",
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

function readFreshCache(storage, account, now, readCache = readCachedResult) {
  if (!storage || typeof readCache !== "function") return null;
  let cached;
  try {
    cached = readCache(storage, account, BRIDGE_MATCHES, now);
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

function cachedAnalysis(cached, account, analyze) {
  const value = cached?.value;
  if (!value || typeof value !== "object") return null;
  if (value.analysis && typeof value.analysis === "object") return value.analysis;
  const responses = value.responses && typeof value.responses === "object"
    ? value.responses
    : value;
  if (!responses.metadata || !responses.community || typeof analyze !== "function") return null;
  try {
    return analyze({
      accountId: account,
      metadata: responses.metadata,
      community: responses.community,
    });
  } catch {
    return null;
  }
}

function cachedGenerated(cached, now) {
  const value = cached?.value;
  const responses = value?.responses;
  const generated = value?.fetchedAt ?? responses?.fetchedAt;
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

function buildErrorForQuery(query, code, options = {}) {
  return buildErrorTitle({
    request: query?.request,
    account: query?.account,
    matches: BRIDGE_MATCHES,
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
      matches: BRIDGE_MATCHES,
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
  fetchImpl,
  apiFetch = fetchDeadlockData,
  analyze = analyzePlayer,
  readCache = readCachedResult,
  writeCache = writeCachedResult,
} = {}) {
  const query = parseBridgeQuery(location?.search ?? "");
  const titleOptions = { documentRef, locationRef: location };
  if (!query.ok) {
    return emitError(query, "invalid_query", {}, titleOptions);
  }

  const currentTime = typeof now === "function" ? now() : now;
  const fresh = readFreshCache(storage, query.account, currentTime, readCache);
  if (fresh) {
    const analysis = cachedAnalysis(fresh, query.account, analyze);
    if (analysis && !isEmptyAnalysis(analysis)) {
      try {
        const title = buildSuccessTitle({
          request: query.request,
          account: query.account,
          matches: BRIDGE_MATCHES,
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
      limit: BRIDGE_MATCHES,
      fetchImpl,
    });
  } catch (error) {
    const failure = genericError(error);
    return emitError(query, failure.code, failure, titleOptions);
  }

  let analysis;
  try {
    analysis = analyze({
      accountId: query.account,
      metadata: response?.metadata,
      community: response?.community,
    });
  } catch {
    return emitError(query, "invalid_payload", {}, titleOptions);
  }
  if (!analysis || !Number.isSafeInteger(analysis.sampleSize)) {
    return emitError(query, "invalid_payload", {}, titleOptions);
  }
  if (isEmptyAnalysis(analysis)) {
    return emitError(query, "empty_sample", {}, titleOptions);
  }

  const value = {
    responses: response,
    analysis,
    fetchedAt: responseGenerated(response, now),
  };

  let title;
  try {
    title = buildSuccessTitle({
      request: query.request,
      account: query.account,
      matches: BRIDGE_MATCHES,
      sample: analysis.sampleSize,
      generated: value.fetchedAt,
      analysis,
    });
  } catch (error) {
    const code = error?.name === "RangeError" ? "payload_too_large" : "invalid_payload";
    return emitError(query, code, {}, titleOptions);
  }

  try {
    writeCache?.(storage, query.account, BRIDGE_MATCHES, value);
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

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void runBridge();
}

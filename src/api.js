const API_ORIGIN = "https://api.deadlock-api.com";
const METADATA_PATH = "/v1/matches/metadata";
const METRICS_PATH = "/v1/analytics/player-stats/metrics";

const EXTRA_PLAYER_COLUMNS = ["mvp_rank"];
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const API_MATCH_MODES = Object.freeze({
  ranked: "ranked",
  standard: "unranked",
});

function assertMode(value) {
  if (!Object.prototype.hasOwnProperty.call(API_MATCH_MODES, value)) {
    throw new TypeError("mode must be ranked or standard");
  }
  return API_MATCH_MODES[value];
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

/**
 * Build the smallest match-metadata request that still contains the match
 * duration, every player's K/D/A, the target player's final stats, and the
 * supplemental MVP/net-worth fields.
 */
function buildMetadataUrl(accountId, limit, mode = "ranked") {
  assertPositiveInteger(accountId, "accountId");
  assertPositiveInteger(limit, "limit");
  const apiMode = assertMode(mode);

  const url = new URL(METADATA_PATH, API_ORIGIN);
  const params = url.searchParams;
  params.set("include_info", "true");
  params.set("include_player_kda", "true");
  params.set("include_player_final_stats", "true");
  params.set("match_mode", apiMode);
  params.set("account_ids", String(accountId));
  params.set("extra_player_columns", EXTRA_PLAYER_COLUMNS.join(","));
  params.set("order_by", "start_time");
  params.set("order_direction", "desc");
  params.set("limit", String(limit));
  params.set("format", "json");
  return url.toString();
}

function buildMetricsUrl(limit = null, mode = "ranked") {
  const apiMode = assertMode(mode);
  const url = new URL(METRICS_PATH, API_ORIGIN);
  url.searchParams.set("match_mode", apiMode);
  if (limit !== null && limit !== undefined) {
    assertPositiveInteger(limit, "limit");
    url.searchParams.set("max_matches", String(limit));
  }
  return url.toString();
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers) return normalized;

  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      normalized[String(key).toLowerCase()] = String(value);
    });
    return normalized;
  }

  if (typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      normalized[String(key).toLowerCase()] = String(value);
    }
    return normalized;
  }

  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        normalized[String(key).toLowerCase()] = String(value);
      }
    }
  }
  return normalized;
}

function safeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, 1000) : null;
}

function safeDetail(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return safeText(payload);
  if (typeof payload !== "object") return safeText(String(payload));

  for (const key of ["detail", "message", "error", "title"]) {
    const detail = safeText(payload[key]);
    if (detail) return detail;
  }
  return null;
}

function safeErrorMessage(error) {
  if (error instanceof Error) return safeText(error.message) || "Request failed";
  return safeText(String(error)) || "Request failed";
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Deadlock API response exceeds the byte limit");
    this.name = "PayloadTooLargeError";
  }
}

function utf8Length(text) {
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

async function readBoundedText(response) {
  if (
    response?.body &&
    typeof response.body.getReader === "function" &&
    typeof TextDecoder === "function"
  ) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value?.byteLength ?? 0;
        if (received > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The size violation is the result even if cancellation races.
          }
          throw new PayloadTooLargeError();
        }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // A consumed or cancelled reader may already have released its lock.
      }
    }
  }
  if (typeof response?.text !== "function") return "";
  const text = await response.text();
  if (utf8Length(text) > MAX_RESPONSE_BYTES) throw new PayloadTooLargeError();
  return text;
}

async function readResponseData(response, headers) {
  const contentLength = Number(headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new PayloadTooLargeError();
  }
  const text = await readBoundedText(response);
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export class ApiError extends Error {
  constructor(message, {
    status = 0,
    retryAfter = null,
    url = "",
    detail = null,
    code = null,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.status = Number.isFinite(status) ? status : 0;
    this.retryAfter = retryAfter ?? null;
    this.url = String(url);
    this.detail = safeDetail(detail);
    this.code = typeof code === "string" ? code : null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      retryAfter: this.retryAfter,
      url: this.url,
      code: this.code,
      detail: this.detail,
    };
  }
}

async function fetchEnvelope(url, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError("Deadlock API request failed", {
      status: 0,
      url,
      detail: safeErrorMessage(error),
      cause: error,
    });
  }

  const status = Number.isFinite(response?.status) ? response.status : 0;
  const headers = normalizeHeaders(response?.headers);
  const contentLength = Number(headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ApiError("Deadlock API response exceeds the byte limit", {
      status,
      retryAfter: headers["retry-after"] ?? null,
      url,
      code: "payload_too_large",
    });
  }
  let data;
  try {
    data = await readResponseData(response, headers);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof PayloadTooLargeError) {
      throw new ApiError("Deadlock API response exceeds the byte limit", {
        status,
        retryAfter: headers["retry-after"] ?? null,
        url,
        code: "payload_too_large",
        cause: error,
      });
    }
    throw new ApiError("Deadlock API response body could not be read", {
      status,
      retryAfter: headers["retry-after"] ?? null,
      url,
      detail: safeErrorMessage(error),
      cause: error,
    });
  }
  const ok = response?.ok ?? (status >= 200 && status < 300);
  if (!ok) {
    const detail = safeDetail(data) || `HTTP ${status || "request"} failure`;
    throw new ApiError(`Deadlock API request failed (${status || "unknown status"})`, {
      status,
      retryAfter: headers["retry-after"] ?? null,
      url,
      detail,
    });
  }

  return { url, status, headers, data };
}

async function fetchDeadlockData({
  accountId,
  limit,
  matches,
  mode = "ranked",
  metricsLimit = null,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  const requestedLimit = limit ?? matches;
  assertPositiveInteger(accountId, "accountId");
  assertPositiveInteger(requestedLimit, "limit");
  assertMode(mode);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const fetchedAt = new Date().toISOString();
  const metadataUrl = buildMetadataUrl(accountId, requestedLimit, mode);
  const communityUrl = buildMetricsUrl(metricsLimit, mode);

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const requestSignal = controller ? controller.signal : signal;
  let detachSignal = null;
  if (controller && signal) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) {
      abort();
    } else if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", abort, { once: true });
      detachSignal = () => signal.removeEventListener?.("abort", abort);
    }
  }
  try {
    const [metadata, community] = await Promise.all([
      fetchEnvelope(metadataUrl, fetchImpl, requestSignal),
      fetchEnvelope(communityUrl, fetchImpl, requestSignal),
    ]);
    return { fetchedAt, metadata, community };
  } catch (error) {
    controller?.abort();
    throw error;
  } finally {
    detachSignal?.();
  }

}

export { buildMetadataUrl, buildMetricsUrl, fetchDeadlockData };

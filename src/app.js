import {
  ApiError,
  fetchDeadlockData,
} from "./api.js";
import {
  FRESH_TTL_MS,
  STALE_TTL_MS,
  clearExpiredResults,
  readCachedResult,
  writeCachedResult,
} from "./cache.js";
import { analyzePlayer } from "./metrics.js";
import {
  bindExplorerControls,
  readControls,
  renderEmpty,
  renderError,
  renderExplorer,
  setLoading,
  writeControls,
} from "./ui.js";

export const SAMPLE_LIMITS = Object.freeze([25, 50, 100, 200]);
export const DEFAULT_LIMIT = 50;
export const CONTROLS_STORAGE_KEY = "deadlock-stats-controls";

const ACCOUNT_ID_PATTERN = /^\d+$/;

function getDefaultStorage() {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function getDefaultLocation() {
  return typeof globalThis.location === "undefined" ? null : globalThis.location;
}

function getDefaultHistory() {
  return typeof globalThis.history === "undefined" ? null : globalThis.history;
}

/**
 * Return a positive safe integer account ID, or null for every invalid input.
 * Decimal, exponential, signed, whitespace-padded, and empty values are not
 * accepted because they do not represent the shareable account-id format.
 */
export function normalizeAccountId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    return null;
  }

  const accountId = Number(value);
  return Number.isSafeInteger(accountId) && accountId > 0
    ? accountId
    : null;
}

export function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : null;

  return SAMPLE_LIMITS.includes(numericValue)
    ? numericValue
    : SAMPLE_LIMITS.includes(fallback)
      ? fallback
      : DEFAULT_LIMIT;
}

function normalizeSearch(search) {
  if (typeof search !== "string") {
    return "";
  }
  return search.startsWith("?") ? search.slice(1) : search;
}

export function parseQueryState(search = getDefaultLocation()?.search ?? "") {
  const params = new URLSearchParams(normalizeSearch(search));
  const accountId = normalizeAccountId(params.get("account_id"));
  const limit = normalizeLimit(params.get("matches"));

  return {
    accountId,
    limit,
    hasAccountId: accountId !== null,
  };
}

function parseRememberedValue(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    const accountId = normalizeAccountId(parsed?.accountId);
    if (accountId === null) {
      return null;
    }

    return {
      accountId,
      limit: normalizeLimit(parsed.limit),
    };
  } catch {
    return null;
  }
}

export function readRememberedControls(storage = getDefaultStorage()) {
  if (!storage || typeof storage.getItem !== "function") {
    return null;
  }

  try {
    return parseRememberedValue(storage.getItem(CONTROLS_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function rememberControls(
  controls,
  storage = getDefaultStorage(),
) {
  const accountId = normalizeAccountId(controls?.accountId);
  if (!storage || accountId === null || typeof storage.setItem !== "function") {
    return false;
  }

  const value = {
    accountId,
    limit: normalizeLimit(controls.limit),
  };

  try {
    storage.setItem(CONTROLS_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function replaceUrlState(controls, location = getDefaultLocation(), history = getDefaultHistory()) {
  if (!location || !history || typeof history.replaceState !== "function") {
    return false;
  }

  const accountId = normalizeAccountId(controls?.accountId);
  if (accountId === null) {
    return false;
  }

  const limit = normalizeLimit(controls.limit);
  let url;
  try {
    url = new URL(location.href ?? location.toString());
  } catch {
    return false;
  }

  url.searchParams.set("account_id", String(accountId));
  url.searchParams.set("matches", String(limit));

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  try {
    history.replaceState(history.state ?? null, "", nextUrl);
    return true;
  } catch {
    return false;
  }
}

function responseEnvelopes(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (value.responses && typeof value.responses === "object") {
    return value.responses;
  }
  if (value.data && typeof value.data === "object") {
    return value.data;
  }
  if (value.metadata && value.community) {
    return value;
  }
  return null;
}

function cachedFetchedAt(value, responses, now) {
  const fetchedAt = value?.fetchedAt ?? responses?.fetchedAt;
  if (typeof fetchedAt === "number" || typeof fetchedAt === "string") {
    return fetchedAt;
  }
  return now;
}

function renderCachedValue({
  cached,
  accountId,
  limit,
  now,
  source,
  analyze = analyzePlayer,
  render = renderExplorer,
}) {
  const responses = responseEnvelopes(cached.value);
  if (!responses) {
    return false;
  }

  const analysis = cached.value?.analysis && typeof cached.value.analysis === "object"
    ? cached.value.analysis
    : (() => {
        if (!responses?.metadata || !responses?.community) {
          return null;
        }
        try {
          return analyze({
            accountId,
            metadata: responses.metadata,
            community: responses.community,
          });
        } catch {
          return null;
        }
      })();
  if (!analysis) {
    return false;
  }

  render({
    accountId,
    limit,
    source: source ?? (cached.freshness === "fresh" ? "cache" : "stale"),
    ageMs: cached.ageMs,
    fetchedAt: cachedFetchedAt(cached.value, responses, now),
    analysis,
    responses,
  });
  return true;
}

function makeErrorModel(
  error,
  { stale = false, preserveData = false, accountId = null, limit = null } = {},
) {
  const isApiError = error instanceof ApiError;
  const status =
    Number.isInteger(error?.status) && error.status > 0 ? error.status : null;
  const retryAfter = error?.retryAfter ?? null;
  const detail = typeof error?.detail === "string" ? error.detail : null;
  const baseMessage =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "The Deadlock API request failed.";
  const message =
    detail && detail !== baseMessage ? `${baseMessage}: ${detail}` : baseMessage;

  return {
    message,
    status,
    retryAfter,
    url: typeof error?.url === "string" ? error.url : null,
    detail,
    stale,
    preserveData,
    accountId,
    limit,
    kind: isApiError ? "api" : "network",
    error,
  };
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError";
}


function defaultDependencies(overrides = {}) {
  return {
    apiFetch: overrides.apiFetch ?? fetchDeadlockData,
    analyze: overrides.analyze ?? analyzePlayer,
    readCache: overrides.readCache ?? readCachedResult,
    writeCache: overrides.writeCache ?? writeCachedResult,
    clearCache: overrides.clearCache ?? clearExpiredResults,
    storage: overrides.storage ?? getDefaultStorage(),
    now: overrides.now ?? (() => Date.now()),
    fetchImpl: overrides.fetchImpl,
    location: overrides.location ?? getDefaultLocation(),
    history: overrides.history ?? getDefaultHistory(),
    ui: overrides.ui ?? {
      bindExplorerControls,
      readControls,
      renderEmpty,
      renderError,
      renderExplorer,
      setLoading,
      writeControls,
    },
  };
}

/**
 * Create the browser coordinator. Dependencies are injectable so the state
 * machine can be exercised without a network, DOM, or storage implementation.
 */
export function createExplorerApp(overrides = {}) {
  const deps = defaultDependencies(overrides);
  const ui = deps.ui;
  let started = false;
  let inFlight = null;
  let requestSequence = 0;
  let currentControls = null;
  let lastResult = null;

  function readAndNormalizeControls() {
    const controls = ui.readControls?.() ?? {};
    const accountId = normalizeAccountId(controls.accountId);
    return {
      accountId,
      limit: normalizeLimit(controls.limit),
    };
  }

  function syncControls(controls) {
    currentControls = controls;
    ui.writeControls?.(controls);
    rememberControls(controls, deps.storage);
    replaceUrlState(controls, deps.location, deps.history);
  }

  function showInvalidAccount(controls) {
    cancel();
    ui.setLoading?.(false);
    ui.renderError?.({
      message: "Enter a positive safe-integer Deadlock account ID.",
      status: null,
      retryAfter: null,
      stale: false,
      preserveData: true,
      accountId: controls.accountId,
      limit: controls.limit,
      kind: "validation",
      error: null,
    });
  }

  function showCached(cached, controls, now, source) {
    return renderCachedValue({
      cached,
      accountId: controls.accountId,
      limit: controls.limit,
      now,
      source,
      analyze: deps.analyze,
      render: ui.renderExplorer,
    });
  }

  async function runLookup({ explicitRefresh = false, controls: suppliedControls } = {}) {
    const rawControls = suppliedControls ?? readAndNormalizeControls();
    const controls = {
      accountId: normalizeAccountId(rawControls.accountId),
      limit: normalizeLimit(rawControls.limit),
    };

    if (controls.accountId === null) {
      showInvalidAccount(controls);
      return { ok: false, reason: "invalid-account-id" };
    }

    syncControls(controls);
    const now = deps.now();
    const key = `${controls.accountId}:${controls.limit}`;

    if (inFlight) {
      if (inFlight.key === key) {
        return inFlight.promise;
      }
      const supersededRequest = inFlight;
      inFlight = null;
      requestSequence += 1;
      supersededRequest.controller.abort();
    }

    let cached = null;
    try {
      cached = deps.readCache(
        deps.storage,
        controls.accountId,
        controls.limit,
        now,
      );
    } catch {
      cached = null;
    }

    if (!explicitRefresh && cached?.freshness === "fresh") {
      const rendered = showCached(cached, controls, now, "cache");
      ui.setLoading?.(false);
      if (rendered) {
        lastResult = { source: "cache", cached, controls };
        return { ok: true, source: "cache", cached };
      }
    }

    if (cached) {
      showCached(
        cached,
        controls,
        now,
        cached.freshness === "fresh" ? "cache" : "stale",
      );
    }

    ui.setLoading?.(true);
    const controller = new AbortController();
    const sequence = ++requestSequence;

    const promise = (async () => {
      try {
        const response = await deps.apiFetch({
          accountId: controls.accountId,
          limit: controls.limit,
          signal: controller.signal,
          fetchImpl: deps.fetchImpl,
        });
        if (sequence !== requestSequence || controller.signal.aborted) {
          return { ok: false, aborted: true };
        }

        const analysis = deps.analyze({
          accountId: controls.accountId,
          metadata: response.metadata,
          community: response.community,
        });
        const value = {
          responses: response,
          analysis,
          fetchedAt: response.fetchedAt,
        };
        let cacheWriteError = null;
        try {
          deps.writeCache(
            deps.storage,
            controls.accountId,
            controls.limit,
            value,
          );
        } catch (error) {
          cacheWriteError = error;
        }
        if (sequence !== requestSequence || controller.signal.aborted) {
          return { ok: false, aborted: true };
        }

        ui.renderExplorer?.({
          accountId: controls.accountId,
          limit: controls.limit,
          source: "network",
          ageMs: 0,
          fetchedAt: response.fetchedAt,
          analysis,
          responses: response,
        });
        lastResult = { source: "network", value, controls, cacheWriteError };
        return { ok: true, source: "network", value, cacheWriteError };
      } catch (error) {
        if (isAbortError(error, controller.signal) || sequence !== requestSequence) {
          return { ok: false, aborted: true };
        }

        let fallback = null;
        try {
          fallback = deps.readCache(
            deps.storage,
            controls.accountId,
            controls.limit,
            deps.now(),
          );
        } catch {
          fallback = null;
        }

        const fallbackRendered = fallback
          ? showCached(fallback, controls, deps.now(), "stale")
          : false;
        const errorModel = makeErrorModel(error, {
          stale: fallbackRendered,
          preserveData: fallbackRendered,
          accountId: controls.accountId,
          limit: controls.limit,
        });
        ui.renderError?.(errorModel);
        lastResult = fallbackRendered
          ? { source: "stale", cached: fallback, controls, error }
          : { source: "error", controls, error };
        return {
          ok: false,
          error,
          errorModel,
          fallback: fallbackRendered ? fallback : null,
        };
      } finally {
        if (inFlight?.sequence === sequence) {
          inFlight = null;
          ui.setLoading?.(false);
        }
      }
    })();

    inFlight = {
      controller,
      key,
      promise,
      sequence,
    };
    return promise;
  }

  function lookup(controls) {
    return runLookup({
      explicitRefresh: false,
      controls,
    });
  }

  function refresh(controls) {
    return runLookup({
      explicitRefresh: true,
      controls,
    });
  }

  function cancel() {
    if (!inFlight) {
      return false;
    }
    const activeRequest = inFlight;
    inFlight = null;
    requestSequence += 1;
    activeRequest.controller.abort();
    ui.setLoading?.(false);
    return true;
  }

  function start() {
    if (started) {
      return api;
    }
    started = true;

    try {
      deps.clearCache?.(deps.storage, deps.now());
    } catch {
      // Cache cleanup is opportunistic; a read/write can still succeed.
    }

    const queryState = parseQueryState(deps.location?.search ?? "");
    const remembered = readRememberedControls(deps.storage);
    const initialControls = queryState.accountId !== null
      ? queryState
      : remembered ?? { accountId: null, limit: DEFAULT_LIMIT };
    currentControls = {
      accountId: normalizeAccountId(initialControls.accountId),
      limit: normalizeLimit(initialControls.limit),
    };

    ui.writeControls?.(currentControls);
    ui.renderEmpty?.();
    ui.bindExplorerControls?.({
      onLookup: lookup,
      onRefresh: refresh,
    });

    if (queryState.accountId !== null) {
      syncControls({
        accountId: queryState.accountId,
        limit: queryState.limit,
      });
      void runLookup({
        controls: queryState,
        explicitRefresh: false,
      });
    }

    return api;
  }

  const api = {
    cancel,
    getState: () => ({
      controls: currentControls,
      inFlight: Boolean(inFlight),
      lastResult,
    }),
    lookup,
    refresh,
    runLookup,
    start,
  };

  return api;
}

export function bootstrapExplorer(overrides = {}) {
  const app = createExplorerApp(overrides);
  app.start();
  return app;
}

function autoBootstrap() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const start = () => {
    if (!document.getElementById("lookup")) {
      return;
    }
    bootstrapExplorer();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

autoBootstrap();

export { FRESH_TTL_MS, STALE_TTL_MS };

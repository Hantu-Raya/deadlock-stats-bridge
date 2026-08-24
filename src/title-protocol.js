const TITLE_PREFIX = "DLSTATS1:";
const TITLE_MAX_LENGTH = 2048;
const BRIDGE_TITLE = "Deadlock Stats Bridge";
const BRIDGE_VERSION = 1;
const BRIDGE_MATCHES = 50;
const REQUEST_MAX_LENGTH = 64;
const MESSAGE_MAX_LENGTH = 160;
const GENERATED_MAX_LENGTH = 64;

const ACCOUNT_PATTERN = /^\d+$/;
const REQUEST_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

const METRIC_GROUPS = Object.freeze([
  Object.freeze({
    id: "combat",
    metrics: Object.freeze([
      Object.freeze({ id: "kd", source: "kd" }),
      Object.freeze({ id: "kda", source: "kda" }),
    ]),
  }),
  Object.freeze({
    id: "kills",
    metrics: Object.freeze([
      Object.freeze({ id: "average_kills", source: "average-kills" }),
      Object.freeze({ id: "average_assists", source: "average-assists" }),
    ]),
  }),
  Object.freeze({
    id: "survival",
    metrics: Object.freeze([
      Object.freeze({ id: "average_deaths", source: "average-deaths" }),
      Object.freeze({ id: "damage_taken_per_minute", source: "damage-taken-per-minute" }),
    ]),
  }),
  Object.freeze({
    id: "damage",
    metrics: Object.freeze([
      Object.freeze({ id: "player_damage_per_minute", source: "player-damage-per-minute" }),
      Object.freeze({ id: "accuracy", source: "accuracy" }),
      Object.freeze({ id: "critical_hit_rate", source: "critical-hit-rate" }),
    ]),
  }),
  Object.freeze({
    id: "economy",
    metrics: Object.freeze([
      Object.freeze({ id: "net_worth_per_minute", source: "net-worth-per-minute" }),
      Object.freeze({ id: "boss_damage_per_minute", source: "boss-damage-per-minute" }),
    ]),
  }),
  Object.freeze({
    id: "sustain",
    metrics: Object.freeze([
      Object.freeze({ id: "healing_per_minute", source: "healing-per-minute" }),
    ]),
  }),
]);

const GROUP_IDS = Object.freeze(METRIC_GROUPS.map((group) => group.id));
const ERROR_CODES = Object.freeze([
  "invalid_query",
  "network_error",
  "upstream_error",
  "rate_limit",
  "empty_sample",
  "invalid_payload",
  "payload_too_large",
  "internal_error",
]);
const ERROR_CODE_SET = new Set(ERROR_CODES);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSearch(search) {
  if (typeof search !== "string") return "";
  return search.startsWith("?") ? search.slice(1) : search;
}

function oneQueryValue(params, key) {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

export function normalizeAccount(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !ACCOUNT_PATTERN.test(value)) return null;
  const account = Number(value);
  return Number.isSafeInteger(account) && account > 0 ? account : null;
}

export function normalizeRequest(value) {
  return (
    typeof value === "string" &&
    value.length <= REQUEST_MAX_LENGTH &&
    REQUEST_PATTERN.test(value)
  )
    ? value
    : null;
}

export function parseBridgeQuery(search = "") {
  let params;
  try {
    params = new URLSearchParams(normalizeSearch(search));
  } catch {
    return {
      ok: false,
      code: "invalid_query",
      account: null,
      matches: BRIDGE_MATCHES,
      request: null,
      message: "Invalid bridge request.",
    };
  }

  const rawAccount = oneQueryValue(params, "account_id");
  const rawMatches = oneQueryValue(params, "matches");
  const rawRequest = oneQueryValue(params, "request");
  const account = normalizeAccount(rawAccount);
  const request = normalizeRequest(rawRequest);

  if (account === null || rawMatches !== String(BRIDGE_MATCHES) || request === null) {
    return {
      ok: false,
      code: "invalid_query",
      account,
      matches: BRIDGE_MATCHES,
      request,
      message: "Invalid bridge request.",
    };
  }

  return {
    ok: true,
    account,
    matches: BRIDGE_MATCHES,
    request,
  };
}

export function roundMetric(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scaled = value * 100;
  if (!Number.isFinite(scaled)) return null;
  const rounded = Math.round(scaled) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function metricValue(metric, key) {
  if (!isPlainObject(metric)) return null;
  return roundMetric(metric[key]);
}

export function selectMetricGroups(analysis) {
  const metrics = Array.isArray(analysis?.metrics) ? analysis.metrics : [];
  return METRIC_GROUPS.map((group) => ({
    id: group.id,
    metrics: group.metrics.map((definition) => {
      const metric = metrics.find((candidate) => candidate?.id === definition.source);
      return {
        id: definition.id,
        player: metricValue(metric, "value"),
        community: metricValue(metric, "communityValue"),
      };
    }),
  }));
}

function assertRequest(value) {
  const request = normalizeRequest(value);
  if (request === null) throw new TypeError("request must be a bounded ASCII nonce");
  return request;
}

function assertAccount(value) {
  const account = normalizeAccount(value);
  if (account === null) throw new TypeError("account must be a positive safe integer");
  return account;
}

function assertMatches(value) {
  if (value !== BRIDGE_MATCHES) throw new TypeError("matches must be 50");
  return BRIDGE_MATCHES;
}

function assertSample(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > BRIDGE_MATCHES) {
    throw new TypeError("sample must be an integer from 0 through 50");
  }
  return value;
}

function assertGenerated(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > GENERATED_MAX_LENGTH ||
    !PRINTABLE_ASCII_PATTERN.test(value)
  ) {
    throw new TypeError("generated must be bounded printable ASCII");
  }
  return value;
}

function serializePayload(payload) {
  const serialized = JSON.stringify(payload);
  const title = `${TITLE_PREFIX}${serialized}`;
  if (title.length > TITLE_MAX_LENGTH) {
    throw new RangeError("bridge title exceeds 2048 code units");
  }
  return title;
}

export function buildSuccessPayload({ request, account, matches = BRIDGE_MATCHES, sample, generated, analysis } = {}) {
  return {
    v: BRIDGE_VERSION,
    kind: "profile_stats",
    request: assertRequest(request),
    account: assertAccount(account),
    matches: assertMatches(matches),
    sample: assertSample(sample),
    generated: assertGenerated(generated),
    groups: selectMetricGroups(analysis),
  };
}

export function buildSuccessTitle(input) {
  return serializePayload(buildSuccessPayload(input));
}

function normalizeStatus(value) {
  if (!Number.isInteger(value) || value < 100 || value > 599) return null;
  return value;
}

function normalizeRetryAfter(value) {
  if (typeof value === "string" && /^\d{1,5}$/.test(value.trim())) {
    value = Number(value.trim());
  }
  if (!Number.isFinite(value) || value < 0 || value > 86400) return null;
  return Math.round(value);
}

function normalizeMessage(value) {
  if (typeof value !== "string") return null;
  const message = value.trim();
  if (!message || message.length > MESSAGE_MAX_LENGTH || !PRINTABLE_ASCII_PATTERN.test(message)) {
    return null;
  }
  return message;
}

export function buildErrorPayload({
  request = null,
  account = null,
  matches = BRIDGE_MATCHES,
  code,
  status = null,
  retry_after = null,
  retryAfter = null,
  message = null,
} = {}) {
  if (!ERROR_CODE_SET.has(code)) throw new TypeError("code is not allowlisted");
  assertMatches(matches);
  const payload = {
    v: BRIDGE_VERSION,
    kind: "error",
    request: normalizeRequest(request) ?? "",
    account: normalizeAccount(account),
    matches: BRIDGE_MATCHES,
    code,
  };
  const normalizedStatus = normalizeStatus(status);
  const normalizedRetryAfter = normalizeRetryAfter(retry_after ?? retryAfter);
  const normalizedMessage = normalizeMessage(message);
  if (normalizedStatus !== null) payload.status = normalizedStatus;
  if (normalizedRetryAfter !== null) payload.retry_after = normalizedRetryAfter;
  if (normalizedMessage !== null) payload.message = normalizedMessage;
  return payload;
}

export function buildErrorTitle(input) {
  return serializePayload(buildErrorPayload(input));
}

function exactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) return false;
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validMetricValue(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length !== METRIC_GROUPS.length) return false;
  return groups.every((group, groupIndex) => {
    const definition = METRIC_GROUPS[groupIndex];
    if (!exactKeys(group, ["id", "metrics"]) || group.id !== definition.id) return false;
    if (!Array.isArray(group.metrics) || group.metrics.length !== definition.metrics.length) return false;
    return group.metrics.every((metric, metricIndex) => {
      const expected = definition.metrics[metricIndex];
      return (
        exactKeys(metric, ["id", "player", "community"]) &&
        metric.id === expected.id &&
        validMetricValue(metric.player) &&
        validMetricValue(metric.community)
      );
    });
  });
}

export function validateBridgePayload(payload) {
  if (!isPlainObject(payload) || payload.v !== BRIDGE_VERSION) return false;
  if (payload.kind === "profile_stats") {
    return (
      exactKeys(payload, ["v", "kind", "request", "account", "matches", "sample", "generated", "groups"]) &&
      normalizeRequest(payload.request) !== null &&
      normalizeAccount(payload.account) !== null &&
      payload.matches === BRIDGE_MATCHES &&
      Number.isSafeInteger(payload.sample) &&
      payload.sample >= 0 &&
      payload.sample <= BRIDGE_MATCHES &&
      assertPrintableGenerated(payload.generated) &&
      validateGroups(payload.groups)
    );
  }
  if (payload.kind === "error") {
    return (
      exactKeys(payload, ["v", "kind", "request", "account", "matches", "code"], ["status", "retry_after", "message"]) &&
      (payload.request === "" || normalizeRequest(payload.request) !== null) &&
      (payload.account === null || normalizeAccount(payload.account) !== null) &&
      payload.matches === BRIDGE_MATCHES &&
      ERROR_CODE_SET.has(payload.code) &&
      (payload.status === undefined || normalizeStatus(payload.status) !== null) &&
      (payload.retry_after === undefined || normalizeRetryAfter(payload.retry_after) !== null) &&
      (payload.message === undefined || normalizeMessage(payload.message) !== null)
    );
  }
  return false;
}

function assertPrintableGenerated(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= GENERATED_MAX_LENGTH &&
    PRINTABLE_ASCII_PATTERN.test(value)
  );
}

export function parseBridgeTitle(title) {
  if (typeof title !== "string" || title.length > TITLE_MAX_LENGTH || !title.startsWith(TITLE_PREFIX)) {
    return { ok: false, code: "invalid_payload" };
  }
  let payload;
  try {
    payload = JSON.parse(title.slice(TITLE_PREFIX.length));
  } catch {
    return { ok: false, code: "invalid_payload" };
  }
  return validateBridgePayload(payload)
    ? { ok: true, payload }
    : { ok: false, code: "invalid_payload" };
}

export {
  BRIDGE_MATCHES,
  BRIDGE_TITLE,
  BRIDGE_VERSION,
  ERROR_CODES,
  GROUP_IDS,
  METRIC_GROUPS,
  REQUEST_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  TITLE_PREFIX,
};

const TITLE_PREFIX = "DLSTATS2:";
const TITLE_MAX_LENGTH = 2048;
const BRIDGE_TITLE = "Deadlock Stats Bridge";
const LEGACY_BRIDGE_VERSION = 2;
const BRIDGE_VERSION = 3;
const DEFAULT_PROTOCOL = LEGACY_BRIDGE_VERSION;
const SUPPORTED_PROTOCOLS = Object.freeze([LEGACY_BRIDGE_VERSION, BRIDGE_VERSION]);
const ALLOWED_MATCHES = Object.freeze([50, 100, 150]);
const ALLOWED_MODES = Object.freeze(["ranked", "standard"]);
const DEFAULT_MATCHES = 50;
const DEFAULT_MODE = "ranked";
const REQUEST_MAX_LENGTH = 64;
const MESSAGE_MAX_LENGTH = 160;
const GENERATED_MAX_LENGTH = 64;

const ACCOUNT_PATTERN = /^\d+$/;
const REQUEST_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

const LEGACY_METRIC_GROUPS = Object.freeze([
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

const METRIC_GROUPS = Object.freeze([
  LEGACY_METRIC_GROUPS[0],
  LEGACY_METRIC_GROUPS[1],
  LEGACY_METRIC_GROUPS[2],
  Object.freeze({
    id: "damage",
    metrics: Object.freeze([
      Object.freeze({ id: "player_damage_per_minute", source: "player-damage-per-minute" }),
      Object.freeze({ id: "accuracy", source: "accuracy" }),
      Object.freeze({ id: "critical_hit_rate", source: "critical-hit-rate" }),
      Object.freeze({ id: "boss_damage_per_minute", source: "boss-damage-per-minute" }),
    ]),
  }),
  Object.freeze({
    id: "economy",
    metrics: Object.freeze([
      Object.freeze({ id: "net_worth_per_minute", source: "net-worth-per-minute" }),
    ]),
  }),
  LEGACY_METRIC_GROUPS[5],
]);

const METRIC_SOURCES = Object.freeze(
  METRIC_GROUPS.flatMap((group) => group.metrics.map((metric) => metric.source)),
);

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

export function normalizeMatches(value) {
  const matches =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return ALLOWED_MATCHES.includes(matches) ? matches : null;
}

export function normalizeMode(value) {
  return typeof value === "string" && ALLOWED_MODES.includes(value) ? value : null;
}

export function normalizeProtocol(value) {
  const protocol = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return SUPPORTED_PROTOCOLS.includes(protocol) ? protocol : null;
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
      matches: null,
      mode: null,
      request: null,
      protocol: DEFAULT_PROTOCOL,
      message: "Invalid bridge request.",
    };
  }

  const rawAccount = oneQueryValue(params, "account_id");
  const rawMatches = oneQueryValue(params, "matches");
  const rawMode = oneQueryValue(params, "mode");
  const rawRequest = oneQueryValue(params, "request");
  const rawProtocol = oneQueryValue(params, "protocol");
  const protocol = params.has("protocol") ? normalizeProtocol(rawProtocol) : DEFAULT_PROTOCOL;
  const account = normalizeAccount(rawAccount);
  const normalizedMatches = normalizeMatches(rawMatches);
  const matches =
    normalizedMatches !== null && rawMatches === String(normalizedMatches)
      ? normalizedMatches
      : null;
  const mode = normalizeMode(rawMode);
  const request = normalizeRequest(rawRequest);

  if (account === null || matches === null || mode === null || request === null || protocol === null) {
    return {
      ok: false,
      code: "invalid_query",
      account,
      matches,
      mode,
      request,
      protocol,
      message: "Invalid bridge request.",
    };
  }

  return {
    ok: true,
    account,
    matches,
    mode,
    request,
    protocol,
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

function percentileValue(metric) {
  const value = metricValue(metric, "percentile");
  return value === null || value < 0 || value > 100 ? null : value;
}

function metricGroupsForProtocol(protocol) {
  return protocol === BRIDGE_VERSION ? METRIC_GROUPS : LEGACY_METRIC_GROUPS;
}

export function selectMetricGroups(analysis, protocol = DEFAULT_PROTOCOL) {
  const selectedProtocol = assertProtocol(protocol);
  const metrics = Array.isArray(analysis?.metrics) ? analysis.metrics : [];
  if (metrics.length !== METRIC_SOURCES.length) {
    throw new TypeError("analysis must contain every comparison metric");
  }
  const byId = new Map();
  for (const metric of metrics) {
    if (
      !isPlainObject(metric) ||
      !METRIC_SOURCES.includes(metric.id) ||
      byId.has(metric.id)
    ) {
      throw new TypeError("analysis metric IDs must be exact and unique");
    }
    byId.set(metric.id, metric);
  }
  return metricGroupsForProtocol(selectedProtocol).map((group) => ({
    id: group.id,
    metrics: group.metrics.map((definition) => {
      const metric = byId.get(definition.source);
      const result = {
        id: definition.id,
        player: metricValue(metric, "value"),
        community: metricValue(metric, "communityValue"),
      };
      if (selectedProtocol === BRIDGE_VERSION) result.percentile = percentileValue(metric);
      return result;
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
  if (!ALLOWED_MATCHES.includes(value)) {
    throw new TypeError("matches must be one of 50, 100, or 150");
  }
  return value;
}

function assertMode(value) {
  if (!ALLOWED_MODES.includes(value)) {
    throw new TypeError("mode must be ranked or standard");
  }
  return value;
}

function assertProtocol(value) {
  const protocol = normalizeProtocol(value);
  if (protocol === null) throw new TypeError("protocol must be 2 or 3");
  return protocol;
}

function assertSample(value, matches) {
  if (!Number.isSafeInteger(value) || value < 0 || value > matches) {
    throw new TypeError(`sample must be an integer from 0 through ${matches}`);
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
  const title = TITLE_PREFIX + JSON.stringify(payload);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new RangeError("bridge title exceeds the title length limit");
  }
  return title;
}

export function buildSuccessPayload({
  request,
  account,
  matches,
  mode,
  sample,
  generated,
  analysis,
  protocol = DEFAULT_PROTOCOL,
} = {}) {
  const selectedProtocol = assertProtocol(protocol);
  const validatedMatches = assertMatches(matches);
  return {
    v: selectedProtocol,
    kind: "profile_stats",
    request: assertRequest(request),
    account: assertAccount(account),
    matches: validatedMatches,
    mode: assertMode(mode),
    sample: assertSample(sample, validatedMatches),
    generated: assertGenerated(generated),
    groups: selectMetricGroups(analysis, selectedProtocol),
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
  matches = DEFAULT_MATCHES,
  mode = DEFAULT_MODE,
  code,
  status = null,
  retry_after = null,
  retryAfter = null,
  message = null,
  protocol = DEFAULT_PROTOCOL,
} = {}) {
  if (!ERROR_CODE_SET.has(code)) throw new TypeError("code is not allowlisted");
  const payload = {
    v: assertProtocol(protocol),
    kind: "error",
    request: normalizeRequest(request) ?? "",
    account: normalizeAccount(account),
    matches: assertMatches(matches),
    mode: assertMode(mode),
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

function validMetricPercentile(value) {
  return value === null || (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function validateGroups(groups, protocol) {
  const definitions = metricGroupsForProtocol(protocol);
  const hasPercentile = protocol === BRIDGE_VERSION;
  if (!Array.isArray(groups) || groups.length !== definitions.length) return false;
  return groups.every((group, groupIndex) => {
    const definition = definitions[groupIndex];
    if (!exactKeys(group, ["id", "metrics"]) || group.id !== definition.id) return false;
    if (!Array.isArray(group.metrics) || group.metrics.length !== definition.metrics.length) return false;
    return group.metrics.every((metric, metricIndex) => {
      const expected = definition.metrics[metricIndex];
      const required = hasPercentile
        ? ["id", "player", "community", "percentile"]
        : ["id", "player", "community"];
      return (
        exactKeys(metric, required) &&
        metric.id === expected.id &&
        validMetricValue(metric.player) &&
        validMetricValue(metric.community) &&
        (!hasPercentile || validMetricPercentile(metric.percentile))
      );
    });
  });
}

export function validateBridgePayload(payload) {
  if (!isPlainObject(payload) || !SUPPORTED_PROTOCOLS.includes(payload.v)) return false;
  const protocol = payload.v;
  if (payload.kind === "profile_stats") {
    return (
      exactKeys(payload, [
        "v",
        "kind",
        "request",
        "account",
        "matches",
        "mode",
        "sample",
        "generated",
        "groups",
      ]) &&
      normalizeRequest(payload.request) !== null &&
      normalizeAccount(payload.account) !== null &&
      typeof payload.matches === "number" &&
      normalizeMatches(payload.matches) !== null &&
      normalizeMode(payload.mode) !== null &&
      Number.isSafeInteger(payload.sample) &&
      payload.sample >= 0 &&
      payload.sample <= payload.matches &&
      assertPrintableGenerated(payload.generated) &&
      validateGroups(payload.groups, protocol)
    );
  }
  if (payload.kind === "error") {
    return (
      exactKeys(
        payload,
        ["v", "kind", "request", "account", "matches", "mode", "code"],
        ["status", "retry_after", "message"],
      ) &&
      (payload.request === "" || normalizeRequest(payload.request) !== null) &&
      (payload.account === null || normalizeAccount(payload.account) !== null) &&
      typeof payload.matches === "number" &&
      normalizeMatches(payload.matches) !== null &&
      normalizeMode(payload.mode) !== null &&
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
  ALLOWED_MATCHES,
  ALLOWED_MODES,
  BRIDGE_TITLE,
  BRIDGE_VERSION,
  DEFAULT_MATCHES,
  DEFAULT_MODE,
  DEFAULT_PROTOCOL,
  ERROR_CODES,
  GROUP_IDS,
  LEGACY_BRIDGE_VERSION,
  METRIC_GROUPS,
  REQUEST_MAX_LENGTH,
  SUPPORTED_PROTOCOLS,
  TITLE_MAX_LENGTH,
  TITLE_PREFIX,
};

const ALLOWED_LIMITS = new Set([25, 50, 100, 200]);

let activeState = "empty";
let hasResults = false;
let errorVisible = false;
let loading = false;
let controlBinding = null;

function getDocument() {
  return typeof document === "undefined" ? null : document;
}

function getElement(id) {
  const doc = getDocument();
  return doc ? doc.getElementById(id) : null;
}

function setText(id, value) {
  const element = getElement(id);
  if (element) {
    element.textContent = value == null ? "" : String(value);
  }
  return element;
}

function setVisible(id, visible) {
  const element = getElement(id);
  if (element) {
    element.hidden = !visible;
  }
}

function valueIsPresent(value) {
  return value !== null && value !== undefined && value !== "";
}

function displayValue(value, fallback = "Unavailable") {
  if (!valueIsPresent(value)) {
    return fallback;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : fallback;
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
}

function formatDate(value) {
  if (!valueIsPresent(value)) {
    return "Unavailable";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) {
    return "Age unavailable";
  }
  if (ageMs < 60_000) {
    return "Less than a minute old";
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} old`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"}${remainingMinutes ? ` ${remainingMinutes}m` : ""} old`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} old`;
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "Unavailable";
  }
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${hours}h ${minutes}m`;
}

function sourceIsStale(source) {
  const normalized = String(source ?? "").toLowerCase();
  return normalized.includes("stale") || normalized.includes("expired") || normalized.includes("fallback");
}

function sourceLabel(source) {
  const normalized = String(source ?? "").toLowerCase();
  if (sourceIsStale(source)) {
    return "Stale browser cache";
  }
  if (normalized.includes("cache")) {
    return "Fresh browser cache";
  }
  if (normalized.includes("network") || normalized.includes("live") || normalized.includes("api")) {
    return "Live API response";
  }
  return valueIsPresent(source) ? String(source) : "Response source unavailable";
}

function safeJson(value) {
  if (value === undefined) {
    return "No JSON body was returned.";
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? "No JSON body was returned." : serialized;
  } catch {
    return "The response body could not be serialized.";
  }
}

function headerEntries(headers) {
  if (!headers || typeof headers !== "object") {
    return [];
  }
  if (Array.isArray(headers)) {
    return headers
      .filter((entry) => Array.isArray(entry) && entry.length >= 2)
      .map(([name, value]) => [String(name), displayValue(value)]);
  }
  return Object.entries(headers)
    .map(([name, value]) => [String(name), displayValue(value)])
    .sort(([left], [right]) => left.localeCompare(right));
}

function headerValue(headers, names) {
  const wanted = names.map((name) => name.toLowerCase());
  const match = headerEntries(headers).find(([name]) => wanted.includes(name.toLowerCase()));
  return match ? match[1] : null;
}

function responseEnvelope(responses, key) {
  const envelope = responses && typeof responses === "object" ? responses[key] : null;
  return envelope && typeof envelope === "object" ? envelope : {};
}

function appendFact(container, label, value, useCode = false) {
  const doc = getDocument();
  if (!doc || !container) {
    return;
  }
  const term = doc.createElement("dt");
  term.textContent = label;
  const description = doc.createElement("dd");
  if (useCode && valueIsPresent(value)) {
    const code = doc.createElement("code");
    code.textContent = String(value);
    description.append(code);
  } else {
    description.textContent = value == null ? "Unavailable" : String(value);
  }
  container.append(term, description);
}

function createCell(value, unavailable = false) {
  const doc = getDocument();
  const cell = doc.createElement("td");
  cell.textContent = value == null ? "Unavailable" : String(value);
  if (unavailable) {
    cell.classList.add("metric-unavailable");
  }
  return cell;
}

function metricResult(metric) {
  const value = metric && valueIsPresent(metric.displayValue) ? metric.displayValue : metric?.value;
  return {
    text: displayValue(value),
    unavailable: !valueIsPresent(value),
  };
}

function metricCommunityResult(metric) {
  const value = metric && valueIsPresent(metric.communityDisplayValue)
    ? metric.communityDisplayValue
    : metric?.communityValue;
  return {
    text: displayValue(value),
    unavailable: !valueIsPresent(value),
  };
}

function renderMetrics(analysis) {
  const doc = getDocument();
  const body = getElement("metrics-body");
  if (!doc || !body) {
    return;
  }
  body.replaceChildren();
  const metrics = analysis && Array.isArray(analysis.metrics) ? analysis.metrics : [];
  if (metrics.length === 0) {
    const row = doc.createElement("tr");
    const cell = doc.createElement("td");
    cell.colSpan = 4;
    cell.className = "metric-unavailable";
    cell.textContent = "No calculated metrics were returned.";
    row.append(cell);
    body.append(row);
    return;
  }
  metrics.forEach((metric) => {
    const row = doc.createElement("tr");
    const label = valueIsPresent(metric?.label) ? metric.label : metric?.id;
    const player = metricResult(metric);
    const community = metricCommunityResult(metric);
    row.append(
      createCell(valueIsPresent(label) ? label : "Unnamed metric"),
      createCell(player.text, player.unavailable),
      createCell(community.text, community.unavailable),
      createCell(valueIsPresent(metric?.unit) ? metric.unit : "Unavailable", !valueIsPresent(metric?.unit)),
    );
    body.append(row);
  });
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function supplementalParts(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = valueIsPresent(value.displayValue) ? value.displayValue : value.value;
    return {
      value: result,
      unit: value.unit,
    };
  }
  return { value, unit: null };
}

function renderSupplemental(analysis) {
  const doc = getDocument();
  const body = getElement("supplemental-body");
  if (!doc || !body) {
    return;
  }
  body.replaceChildren();
  const supplemental = analysis && analysis.supplemental && typeof analysis.supplemental === "object" ? analysis.supplemental : {};
  const orderedKeys = ["averageMvp", "killParticipation", ...Object.keys(supplemental).filter((key) => !["averageMvp", "killParticipation"].includes(key))];
  const uniqueKeys = [...new Set(orderedKeys)];
  uniqueKeys.forEach((key) => {
    const parts = supplementalParts(supplemental[key]);
    const row = doc.createElement("tr");
    row.append(
      createCell(key === "averageMvp" ? "Average MVP" : key === "killParticipation" ? "Kill participation" : humanizeKey(key)),
      createCell(displayValue(parts.value), !valueIsPresent(parts.value)),
      createCell(valueIsPresent(parts.unit) ? parts.unit : "Unavailable", !valueIsPresent(parts.unit)),
    );
    body.append(row);
  });
}

function renderAnalysisSummary(analysis) {
  const parts = [];
  if (valueIsPresent(analysis?.sampleSize)) {
    parts.push(`Sample size: ${displayValue(analysis.sampleSize)}`);
  }
  if (valueIsPresent(analysis?.totalDurationSeconds)) {
    parts.push(`Total duration: ${formatDuration(analysis.totalDurationSeconds)}`);
  }
  setText("analysis-summary", parts.join(" · "));
}

function renderFreshness(model) {
  const element = getElement("freshness-status");
  const doc = getDocument();
  if (!element || !doc) {
    return;
  }
  element.replaceChildren();
  const stale = sourceIsStale(model?.source);
  const strong = doc.createElement("strong");
  strong.textContent = stale ? "Stale data" : sourceLabel(model?.source);
  const detail = doc.createElement("span");
  const age = formatAge(model?.ageMs);
  detail.textContent = stale
    ? `The API was unavailable. Showing the last successful response, ${age.toLowerCase()}.`
    : `Fetched ${formatDate(model?.fetchedAt)}. ${age}.`;
  element.append(strong, detail);
}

function renderRequestFacts(model) {
  const container = getElement("request-facts");
  if (!container) {
    return;
  }
  container.replaceChildren();
  const metadata = responseEnvelope(model?.responses, "metadata");
  const community = responseEnvelope(model?.responses, "community");
  const metadataCache = headerValue(metadata.headers, ["cache-control", "age", "expires"]);
  const communityCache = headerValue(community.headers, ["cache-control", "age", "expires"]);
  const metadataRate = headerValue(metadata.headers, ["x-ratelimit-remaining", "ratelimit-remaining"]);
  const communityRate = headerValue(community.headers, ["x-ratelimit-remaining", "ratelimit-remaining"]);
  const metadataRateLimit = headerValue(metadata.headers, ["x-ratelimit-limit", "ratelimit-limit"]);
  const communityRateLimit = headerValue(community.headers, ["x-ratelimit-limit", "ratelimit-limit"]);
  const cacheParts = [
    metadataCache ? `Metadata: ${metadataCache}` : null,
    communityCache ? `Community: ${communityCache}` : null,
  ].filter(Boolean);
  const rateParts = [
    metadataRate || metadataRateLimit ? `Metadata: ${metadataRate ?? "remaining unavailable"}${metadataRateLimit ? ` of ${metadataRateLimit}` : ""}` : null,
    communityRate || communityRateLimit ? `Community: ${communityRate ?? "remaining unavailable"}${communityRateLimit ? ` of ${communityRateLimit}` : ""}` : null,
  ].filter(Boolean);

  appendFact(container, "Account ID", model?.accountId);
  appendFact(container, "Sample size", valueIsPresent(model?.limit) ? `${displayValue(model.limit)} matches` : null);
  appendFact(container, "Data source", sourceLabel(model?.source));
  appendFact(container, "Fetched", formatDate(model?.fetchedAt));
  appendFact(container, "Metadata HTTP", valueIsPresent(metadata.status) ? metadata.status : null);
  appendFact(container, "Community HTTP", valueIsPresent(community.status) ? community.status : null);
  appendFact(container, "Cache details", cacheParts.length ? cacheParts.join("; ") : "No cache headers returned");
  appendFact(container, "Rate-limit details", rateParts.length ? rateParts.join("; ") : "No rate-limit headers returned");
  appendFact(container, "Metadata URL", metadata.url, true);
  appendFact(container, "Community URL", community.url, true);
}

function appendResponseDetails(container, label, envelope) {
  const doc = getDocument();
  if (!doc || !container) {
    return;
  }
  const details = doc.createElement("details");
  details.className = "response-detail";
  const summary = doc.createElement("summary");
  summary.textContent = label;
  details.append(summary);

  const content = doc.createElement("div");
  content.className = "response-content";
  const url = doc.createElement("code");
  url.className = "response-url";
  url.textContent = valueIsPresent(envelope.url) ? envelope.url : "Request URL unavailable";
  content.append(url);

  const status = doc.createElement("p");
  status.className = "response-status";
  status.textContent = valueIsPresent(envelope.status) ? `HTTP status: ${envelope.status}` : "HTTP status unavailable";
  content.append(status);

  const entries = headerEntries(envelope.headers);
  const headerTitle = doc.createElement("h4");
  headerTitle.className = "response-subheading";
  headerTitle.textContent = "Response headers";
  content.append(headerTitle);
  if (entries.length) {
    const headerList = doc.createElement("dl");
    headerList.className = "response-headers";
    entries.forEach(([name, value]) => {
      const term = doc.createElement("dt");
      term.textContent = name;
      const description = doc.createElement("dd");
      description.className = "response-header-value";
      description.textContent = value;
      headerList.append(term, description);
    });
    content.append(headerList);
  } else {
    const noHeaders = doc.createElement("p");
    noHeaders.className = "response-status";
    noHeaders.textContent = "No response headers were returned.";
    content.append(noHeaders);
  }

  const rawTitle = doc.createElement("h4");
  rawTitle.className = "response-subheading";
  rawTitle.textContent = "Raw JSON";
  content.append(rawTitle);
  const raw = doc.createElement("pre");
  raw.className = "raw-json";
  raw.textContent = safeJson(envelope.data);
  content.append(raw);

  details.append(content);
  container.append(details);
}

function renderResponses(responses) {
  const container = getElement("responses-list");
  if (!container) {
    return;
  }
  container.replaceChildren();
  appendResponseDetails(container, "Metadata response", responseEnvelope(responses, "metadata"));
  appendResponseDetails(container, "Community response", responseEnvelope(responses, "community"));
}

function syncVisibility() {
  setVisible("empty-state", !loading && activeState === "empty");
  setVisible("loading-state", loading);
  setVisible("error-state", !loading && errorVisible);
  setVisible("results-state", !loading && hasResults && activeState === "results");
  const output = getElement("explorer-output");
  if (output) {
    output.setAttribute("aria-busy", String(loading));
  }
}

function syncButtons() {
  const lookup = getElement("lookup");
  const refresh = getElement("refresh");
  if (lookup) {
    lookup.disabled = loading;
    lookup.setAttribute("aria-busy", String(loading));
  }
  if (refresh) {
    refresh.disabled = loading || !hasResults;
    refresh.setAttribute("aria-busy", String(loading));
  }
}

function errorParts(errorModel) {
  const model = errorModel && typeof errorModel === "object" ? errorModel : {};
  const primary = valueIsPresent(model.message)
    ? String(model.message)
    : valueIsPresent(model.detail)
      ? String(model.detail)
      : "The API did not return a usable response.";
  const detailText = valueIsPresent(model.detail) ? String(model.detail) : "";
  const detail = detailText && detailText !== primary && !primary.includes(detailText)
    ? ` ${detailText}`
    : "";
  const meta = [];
  if (valueIsPresent(model.status)) {
    meta.push(`HTTP ${model.status}`);
  }
  if (valueIsPresent(model.retryAfter)) {
    meta.push(`Retry-After: ${model.retryAfter}`);
  }
  if (valueIsPresent(model.url)) {
    meta.push(`URL: ${model.url}`);
  }
  return { message: `${primary}${detail}`, meta: meta.join(" · ") };
}

export function bindExplorerControls({ onLookup, onRefresh } = {}) {
  const form = getElement("explorer-form");
  const refreshButton = getElement("refresh");
  if (!form || !refreshButton) {
    return () => {};
  }

  if (controlBinding) {
    controlBinding.form.removeEventListener("submit", controlBinding.submit);
    controlBinding.refreshButton.removeEventListener("click", controlBinding.refresh);
  }

  const submit = (event) => {
    event.preventDefault();
    if (typeof onLookup === "function") {
      onLookup(readControls());
    }
  };
  const refresh = (event) => {
    event.preventDefault();
    if (typeof onRefresh === "function") {
      onRefresh(readControls());
    }
  };
  form.addEventListener("submit", submit);
  refreshButton.addEventListener("click", refresh);
  controlBinding = { form, refreshButton, submit, refresh };

  return () => {
    if (!controlBinding) {
      return;
    }
    controlBinding.form.removeEventListener("submit", controlBinding.submit);
    controlBinding.refreshButton.removeEventListener("click", controlBinding.refresh);
    controlBinding = null;
  };
}

export function readControls() {
  const accountInput = getElement("account-id");
  const limitInput = getElement("sample-limit");
  const rawLimit = limitInput ? Number(limitInput.value) : 50;
  return {
    accountId: accountInput ? accountInput.value.trim() : "",
    limit: ALLOWED_LIMITS.has(rawLimit) ? rawLimit : 50,
  };
}

export function writeControls({ accountId, limit } = {}) {
  const accountInput = getElement("account-id");
  const limitInput = getElement("sample-limit");
  if (accountInput && accountId !== undefined && accountId !== null) {
    accountInput.value = String(accountId);
  }
  if (limitInput && ALLOWED_LIMITS.has(Number(limit))) {
    limitInput.value = String(Number(limit));
  }
}

export function setLoading(isLoading) {
  loading = Boolean(isLoading);
  if (loading) {
    errorVisible = false;
    setText("control-message", "Loading player data.");
  }
  syncVisibility();
  syncButtons();
}

export function renderExplorer(model = {}) {
  loading = false;
  activeState = "results";
  hasResults = true;
  errorVisible = false;
  renderFreshness(model);
  renderRequestFacts(model);
  renderAnalysisSummary(model.analysis);
  renderMetrics(model.analysis);
  renderSupplemental(model.analysis);
  renderResponses(model.responses);
  const account = valueIsPresent(model.accountId) ? String(model.accountId) : "selected account";
  const limit = valueIsPresent(model.limit) ? String(model.limit) : "selected sample";
  setText("control-message", `Loaded ${account} using ${limit} matches.`);
  syncVisibility();
  syncButtons();
}

export function renderError(errorModel = {}) {
  const preserveData = Boolean(errorModel?.stale || errorModel?.preserveData || errorModel?.keepResults) && hasResults;
  const parts = errorParts(errorModel);
  setText("error-message", parts.message);
  setText("error-meta", parts.meta);
  if (preserveData) {
    loading = false;
    activeState = "results";
    errorVisible = true;
    setText("control-message", "The refresh failed. Showing the last successful response.");
  } else {
    loading = false;
    activeState = "error";
    hasResults = false;
    errorVisible = true;
    setText("control-message", "Request failed.");
  }
  syncVisibility();
  syncButtons();
}

export function renderEmpty() {
  loading = false;
  activeState = "empty";
  hasResults = false;
  errorVisible = false;
  setText("control-message", "");
  setText("error-message", "Try again after checking the account ID.");
  setText("error-meta", "");
  syncVisibility();
  syncButtons();
}

// One-shot Panorama bridge for ShowRank party markers.
// Groups lobby players who are Steam friends and on the same team in the current match.
// deadlock-api uses the same rule for its historical `same_party` flag.
import { ApiError, fetchEnvelope } from "./api.js?v=20261018-1";

export const PARTY_TITLE_PREFIX = "DLPARTY1:";
export const PARTY_PROTOCOL = 1;
export const PARTY_TITLE_MAX_LENGTH = 2048;
export const MAX_TEAM_ACCOUNTS = 6;
const STEAM_URL = "https://api.deadlock-api.com/v1/players/steam";
const REQUEST_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_PATTERN = /^[1-9][0-9]{0,9}$/;
const MAX_ACCOUNT = 4294967295;

function parseAccounts(value) {
  if (typeof value !== "string" || value === "") return null;
  const parts = value.split(",");
  if (parts.length > MAX_TEAM_ACCOUNTS) return null;
  const accounts = [];
  for (const part of parts) {
    if (!ACCOUNT_PATTERN.test(part)) return null;
    const account = Number(part);
    if (account > MAX_ACCOUNT || accounts.includes(account)) return null;
    accounts.push(account);
  }
  return accounts;
}

/** Parse `?protocol=1&request=<nonce>&friendly=<ids>&enemy=<ids>`; null when anything is malformed. */
export function parsePartyQuery(search) {
  let params;
  try { params = new URLSearchParams(typeof search === "string" ? search : ""); } catch { return null; }
  if (params.get("protocol") !== String(PARTY_PROTOCOL)) return null;
  const request = params.get("request");
  if (typeof request !== "string" || !REQUEST_PATTERN.test(request)) return null;
  const friendly = parseAccounts(params.get("friendly"));
  const enemy = parseAccounts(params.get("enemy"));
  if (!friendly || !enemy || friendly.some((account) => enemy.includes(account))) return null;
  return { request, friendly, enemy };
}

export function buildSteamUrl(accounts) {
  return `${STEAM_URL}?account_ids=${[...accounts].sort((a, b) => a - b).join(",")}`;
}

function isAccount(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_ACCOUNT;
}

/** Validate the Steam profile batch shape; throws `invalid_payload` on anything unexpected. */
function readProfiles(data) {
  const invalid = () => new ApiError("Steam profile payload is invalid", { code: "invalid_payload" });
  if (!Array.isArray(data)) throw invalid();
  return data.map((entry) => {
    if (!entry || typeof entry !== "object" || !isAccount(entry.account_id)) throw invalid();
    const friends = entry.friends ?? [];
    if (!Array.isArray(friends)) throw invalid();
    return {
      account: entry.account_id,
      friends: friends.map((friend) => {
        if (!friend || typeof friend !== "object" || !isAccount(friend.account_id)) throw invalid();
        return friend.account_id;
      }),
    };
  });
}

/** Same-team friendship components with at least two members, sorted for stable colors. */
export function friendGroups(data, { friendly, enemy }) {
  const profiles = readProfiles(data);
  const team = new Map();
  for (const account of friendly) team.set(account, "friendly");
  for (const account of enemy) team.set(account, "enemy");
  const parent = new Map([...team.keys()].map((account) => [account, account]));
  const find = (account) => {
    let root = account;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(account, root);
    return root;
  };
  for (const { account, friends } of profiles) {
    if (!team.has(account)) continue;
    for (const friend of friends) {
      if (friend === account || team.get(friend) !== team.get(account)) continue;
      const a = find(account);
      const b = find(friend);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  }
  const groups = new Map();
  for (const account of team.keys()) {
    const root = find(account);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(account);
  }
  return [...groups.values()]
    .filter((members) => members.length >= 2)
    .map((members) => members.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

function errorCode(error) {
  if (error?.code === "invalid_payload") return "invalid_payload";
  if (error instanceof ApiError || error?.name === "ApiError") {
    if (error.status === 429) return "rate_limit";
    if (Number.isInteger(error.status) && error.status > 0) return "upstream_error";
  }
  return "network_error";
}

export function buildPartyTitle(payload) {
  const title = PARTY_TITLE_PREFIX + JSON.stringify({ v: PARTY_PROTOCOL, ...payload });
  if (title.length > PARTY_TITLE_MAX_LENGTH) throw new RangeError("party title exceeds the title length limit");
  return title;
}

function publish(title, documentRef, locationRef) {
  try {
    documentRef.title = title;
    if (locationRef) locationRef.hash = encodeURIComponent(title);
    return true;
  } catch {
    return false;
  }
}

export async function runPartyBridge({
  locationRef = globalThis.location ?? null,
  documentRef = globalThis.document ?? null,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const query = parsePartyQuery(locationRef?.search ?? "");
  if (!query) {
    publish(buildPartyTitle({ request: "", kind: "error", code: "invalid_query" }), documentRef, locationRef);
    return { ok: false, code: "invalid_query" };
  }
  let groups;
  try {
    const { data } = await fetchEnvelope(buildSteamUrl([...query.friendly, ...query.enemy]), fetchImpl, signal);
    groups = friendGroups(data, query);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { ok: false, code: "aborted" };
    const code = errorCode(error);
    publish(buildPartyTitle({ request: query.request, kind: "error", code }), documentRef, locationRef);
    return { ok: false, code };
  }
  if (signal?.aborted) return { ok: false, code: "aborted" };
  publish(buildPartyTitle({ request: query.request, kind: "ok", groups }), documentRef, locationRef);
  return { ok: true, groups };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  window.addEventListener?.("pagehide", () => controller?.abort(), { once: true });
  void runPartyBridge({ signal: controller?.signal });
}

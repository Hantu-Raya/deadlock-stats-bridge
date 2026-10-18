import test from "node:test";
import assert from "node:assert/strict";

import {
  PARTY_TITLE_PREFIX,
  buildSteamUrl,
  friendGroups,
  parsePartyQuery,
  runPartyBridge,
} from "../src/party.js";

const FRIENDLY = [101, 102, 103, 104, 105, 106];
const ENEMY = [201, 202, 203, 204, 205, 206];

function query(overrides = {}) {
  const params = new URLSearchParams({
    protocol: "1",
    request: "n1",
    friendly: FRIENDLY.join(","),
    enemy: ENEMY.join(","),
    ...overrides,
  });
  return `?${params.toString()}`;
}

function profile(accountId, friendIds) {
  return {
    account_id: accountId,
    personaname: `p${accountId}`,
    friends: friendIds === null ? null : friendIds.map((id) => ({ account_id: id, friend_since: "2025-01-01T00:00:00Z" })),
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(Object.entries({ "content-type": "application/json", ...headers })),
    text: async () => JSON.stringify(data),
  };
}

function harness(fetchImpl, search = query()) {
  const documentRef = { title: "" };
  const locationRef = { search, hash: "" };
  return {
    documentRef,
    locationRef,
    run: (extra = {}) => runPartyBridge({ locationRef, documentRef, fetchImpl, ...extra }),
    payload() {
      assert.ok(documentRef.title.startsWith(PARTY_TITLE_PREFIX), documentRef.title);
      assert.equal(decodeURIComponent(locationRef.hash), documentRef.title, "fragment mirrors the title");
      return JSON.parse(documentRef.title.slice(PARTY_TITLE_PREFIX.length));
    },
  };
}

test("query parsing rejects every malformed request", () => {
  assert.deepEqual(parsePartyQuery(query()), { request: "n1", friendly: FRIENDLY, enemy: ENEMY });
  assert.deepEqual(parsePartyQuery(query({ friendly: "101,102", enemy: "201" })).friendly, [101, 102]);
  const bad = [
    { protocol: "2" },
    { request: "" },
    { request: "bad request" },
    { request: "x".repeat(65) },
    { friendly: "" },
    { friendly: "101,101" },
    { friendly: "101,abc" },
    { friendly: "0" },
    { friendly: "0101" },
    { friendly: "4294967296" },
    { friendly: "101,102,103,104,105,106,107" },
    { enemy: "101" },
  ];
  for (const overrides of bad) {
    assert.equal(parsePartyQuery(query(overrides)), null, JSON.stringify(overrides));
  }
  assert.equal(parsePartyQuery(""), null);
});

test("steam url requests every lobby account once, sorted", () => {
  assert.equal(buildSteamUrl([202, 101, 103]), "https://api.deadlock-api.com/v1/players/steam?account_ids=101,103,202");
});

test("friend groups are same-team, symmetric, transitive and deterministic", () => {
  const teams = { friendly: FRIENDLY, enemy: ENEMY };
  const profiles = [
    profile(103, [101, 104]), // star around 103 links 101 and 104 without a 101-104 edge
    profile(105, [201, 999]), // cross-team and non-lobby friends never link
    profile(206, []),
    profile(204, null),
    profile(203, [206]), // only one side lists the friendship
    profile(777, [101, 102]), // unrequested profile is ignored
  ];
  assert.deepEqual(friendGroups(profiles, teams), [[101, 103, 104], [203, 206]]);
  assert.deepEqual(friendGroups([], teams), []);
});

test("success publishes groups in title and fragment", async () => {
  const urls = [];
  const h = harness(async (url) => {
    urls.push(url);
    return jsonResponse([profile(101, [102]), profile(201, [202, 203])]);
  });
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(urls.length, 1, "one batch request");
  assert.match(urls[0], /account_ids=101,102,103,104,105,106,201,202,203,204,205,206$/);
  assert.deepEqual(h.payload(), { v: 1, request: "n1", kind: "ok", groups: [[101, 102], [201, 202, 203]] });
});

test("failures publish typed error titles", async () => {
  const cases = [
    [async () => { throw new TypeError("offline"); }, "network_error"],
    [async () => jsonResponse({ detail: "slow down" }, 429, { "retry-after": "30" }), "rate_limit"],
    [async () => jsonResponse({ detail: "boom" }, 500), "upstream_error"],
    [async () => jsonResponse({ not: "an array" }), "invalid_payload"],
    [async () => jsonResponse([{ account_id: "101", friends: [] }]), "invalid_payload"],
    [async () => jsonResponse([{ account_id: 101, friends: [{ account_id: -1 }] }]), "invalid_payload"],
  ];
  for (const [fetchImpl, code] of cases) {
    const h = harness(fetchImpl);
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.deepEqual(h.payload(), { v: 1, request: "n1", kind: "error", code });
  }
});

test("invalid query never calls the API", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return jsonResponse([]); }, query({ friendly: "101,101" }));
  await h.run();
  assert.equal(calls, 0);
  assert.deepEqual(h.payload(), { v: 1, request: "", kind: "error", code: "invalid_query" });
});

test("aborted page publishes nothing", async () => {
  const controller = new AbortController();
  const h = harness(async () => {
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await h.run({ signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(h.documentRef.title, "");
  assert.equal(h.locationRef.hash, "");
});

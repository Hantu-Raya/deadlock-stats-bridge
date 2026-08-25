import test from "node:test";
import assert from "node:assert/strict";

import { readControls, renderExplorer, setCooldown, writeControls } from "../src/ui.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = { add: () => {} };
    this.open = false;
    this.hidden = false;
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  dispatch(name) {
    this.listeners.get(name)?.({ target: this });
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
  }

  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement("div"));
    return this.elements.get(id);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function model(responses) {
  return {
    accountId: 123,
    limit: 50,
    source: "network",
    ageMs: 0,
    fetchedAt: "2026-08-25T00:00:00.000Z",
    analysis: { sampleSize: 1, metrics: [], supplemental: {} },
    responses,
  };
}

test("raw JSON serializes only when details opens and cached results explain omission", () => {
  const previousDocument = globalThis.document;
  const previousStringify = JSON.stringify;
  const documentRef = new FakeDocument();
  let stringifyCalls = 0;
  JSON.stringify = (...args) => {
    stringifyCalls += 1;
    return previousStringify(...args);
  };
  globalThis.document = documentRef;

  try {
    renderExplorer(model({
      metadata: {
        url: "https://api.example.test/metadata",
        status: 200,
        headers: {},
        rawRetained: true,
        data: { matches: [{ match_id: 1 }] },
      },
      community: { url: "https://api.example.test/community", status: 200, headers: {}, rawRetained: false },
    }));

    const responses = documentRef.getElementById("responses-list");
    const metadataDetails = responses.children[0];
    assert.equal(stringifyCalls, 0);
    metadataDetails.dispatch("toggle");
    assert.equal(stringifyCalls, 0);

    metadataDetails.open = true;
    metadataDetails.dispatch("toggle");
    assert.equal(stringifyCalls, 1);
    const raw = metadataDetails.children[1].children.at(-1).children[0];
    assert.match(raw.textContent, /match_id/);

    renderExplorer(model({
      metadata: {
        url: "https://api.example.test/metadata",
        status: 200,
        headers: {},
        rawRetained: false,
      },
      community: { url: "https://api.example.test/community", status: 200, headers: {}, rawRetained: false },
    }));
    const cachedMetadataDetails = documentRef.getElementById("responses-list").children[0];
    const cachedHint = cachedMetadataDetails.children[1].children.at(-1).children[0];
    assert.match(cachedHint.textContent, /Raw body was not retained in compact cache/);
    cachedMetadataDetails.open = true;
    cachedMetadataDetails.dispatch("toggle");
    assert.equal(stringifyCalls, 1);
  } finally {
    JSON.stringify = previousStringify;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("a shorter cooldown cannot replace a longer active cooldown", async () => {
  const previousDocument = globalThis.document;
  const documentRef = new FakeDocument();
  globalThis.document = documentRef;
  try {
    setCooldown(1_000);
    setCooldown(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(documentRef.getElementById("lookup").disabled, true);
    setCooldown(0);
    assert.equal(documentRef.getElementById("lookup").disabled, false);
  } finally {
    setCooldown(0);
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("mode controls round-trip standard and ranked selections", () => {
  const previousDocument = globalThis.document;
  const documentRef = new FakeDocument();
  globalThis.document = documentRef;
  try {
    documentRef.getElementById("account-id").value = " 215334735 ";
    documentRef.getElementById("sample-limit").value = "100";
    documentRef.getElementById("match-mode").value = "standard";
    assert.deepEqual(readControls(), {
      accountId: "215334735",
      limit: 100,
      mode: "standard",
    });

    writeControls({ accountId: 50, limit: 25, mode: "ranked" });
    assert.equal(documentRef.getElementById("account-id").value, "50");
    assert.equal(documentRef.getElementById("sample-limit").value, "25");
    assert.equal(documentRef.getElementById("match-mode").value, "ranked");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

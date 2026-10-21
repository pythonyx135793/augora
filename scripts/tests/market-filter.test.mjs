import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const html = await readFile(new URL("../../frontend/index.html", import.meta.url), "utf8");
let fixtureId = 0;

async function loadPage(t) {
  const errors = [];
  const externalCalls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  // Parse the real page without running its script tags or fetching resources.
  // Import script.js explicitly below, after installing the isolated environment.
  const dom = new JSDOM(html, {
    url: "https://augora.test/",
    runScripts: "outside-only",
    virtualConsole,
  });
  const { window } = dom;
  const saved = new Map();
  const timers = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeClearInterval = globalThis.clearInterval;
  const block = (kind) => () => {
    externalCalls.push(kind);
    throw new Error(`Unexpected ${kind} in market-filter test`);
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.fetch = block("window fetch");
  window.XMLHttpRequest = block("XMLHttpRequest");
  window.WebSocket = block("WebSocket");
  window.stellarWallet = new Proxy({}, { get: block("wallet access") });

  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    sessionStorage: window.sessionStorage,
    fetch: block("fetch"),
    // Track application timers so even an import failure cannot leak handles.
    setTimeout: (...args) => { const handle = nativeSetTimeout(...args); timers.add(handle); return handle; },
    setInterval: (...args) => { const handle = nativeSetInterval(...args); timers.add(handle); return handle; },
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    // Restore native timers before JSDOM cancels its outstanding handles.
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    for (const handle of timers) { nativeClearTimeout(handle); nativeClearInterval(handle); }
    window.close();
    assert.deepEqual(errors, [], "DOM event handlers must not throw");
    assert.deepEqual(externalCalls, [], "filtering must not use network or wallet APIs");
  });
  // JSDOM's default hidden document prevents the application's public polling.
  assert.equal(window.document.hidden, true);
  const moduleUrl = new URL("../../frontend/script.js", import.meta.url);
  moduleUrl.searchParams.set("fixture", String(++fixtureId));
  const { baseMarkets } = await import(moduleUrl.href);
  return { window, document: window.document, baseMarkets };
}

function assertFilter({ document, baseMarkets }, category) {
  const button = document.querySelector(`[data-filter="${category}"]`);
  const active = [...document.querySelectorAll("[data-filter].active")];
  assert.deepEqual(active, [button], "only the selected filter is active");
  const expected = baseMarkets.filter((market) => category === "all" || market.category === category);
  const cards = [...document.querySelectorAll("#market-list .market-card")];
  assert.equal(cards.length, expected.length, "card count matches the production market data");
  assert.deepEqual(cards.map((card) => card.querySelector("h3").textContent), expected.map((market) => market.title));
  assert.deepEqual(cards.map((card) => card.querySelector(".category").textContent), expected.map((market) => market.category));
}

test("initial page renders all production markets", async (t) => {
  const page = await loadPage(t);
  assert.ok(page.baseMarkets.some((market) => market.category === "crypto"));
  assert.ok(page.baseMarkets.some((market) => market.category === "network"));
  assertFilter(page, "all");
});

test("Crypto click selects only Crypto and renders its production market count", async (t) => {
  const page = await loadPage(t);
  page.document.querySelector('[data-filter="crypto"]').dispatchEvent(
    new page.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  assertFilter(page, "crypto");
});

test("repeated category switches replace cards without duplicate active buttons", async (t) => {
  const page = await loadPage(t);
  for (const category of ["crypto", "network", "all", "network", "network", "crypto", "all"]) {
    page.document.querySelector(`[data-filter="${category}"]`).click();
    assertFilter(page, category);
  }
});

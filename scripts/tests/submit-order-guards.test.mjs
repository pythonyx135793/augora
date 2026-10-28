import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const html = await readFile(new URL("../../frontend/index.html", import.meta.url), "utf8");
const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`;
let fixtureId = 0;

async function loadPage(t, { balance = 200, address = "TEST-WALLET", deferred = false } = {}) {
  const errors = [];
  const externalCalls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  // Use actual page markup; do not execute wallet.js or fetch page resources.
  const dom = new JSDOM(html, { url: "https://augora.test/", runScripts: "outside-only", virtualConsole });
  const { window } = dom;
  const { document } = window;
  const saved = new Map();
  const timers = new Set();
  const pending = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeClearInterval = globalThis.clearInterval;
  const block = (kind) => () => {
    externalCalls.push(kind);
    throw new Error(`Unexpected ${kind} in wallet-guard test`);
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = block("window fetch");
  window.XMLHttpRequest = block("XMLHttpRequest");
  window.WebSocket = block("WebSocket");
  const walletState = { address, balance };
  const connect = t.mock.fn(async () => {});
  const refreshBalance = t.mock.fn(async () => {});
  window.stellarWallet = {
    getState: t.mock.fn(() => walletState),
    connect,
    refreshBalance,
    signTransaction: block("wallet signing"),
  };

  let release;
  const tradeReady = deferred ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const placeBet = t.mock.fn(async () => {
    await tradeReady;
    return { hash: "a".repeat(64), explorerUrl };
  });
  const reducePosition = t.mock.fn(block("reducePosition"));
  const checkTransactionStatus = t.mock.fn(block("transaction polling"));
  // Register mocks BEFORE the production module imports these dependencies.
  // No production global injection hook or real SDK/wallet import is needed.
  t.mock.module(new URL("../../frontend/soroban.js", import.meta.url).href, {
    namedExports: {
      TESTNET: { predictionMarketContract: "TEST-CONTRACT", explorerUrl: "https://stellar.expert/explorer/testnet/tx" },
      placeBet, reducePosition, checkTransactionStatus,
    },
  });
  t.mock.module(new URL("../../frontend/fetch.js", import.meta.url).href, {
    namedExports: { fetchJson: block("public data request") },
  });

  for (const [key, value] of Object.entries({
    window, document, sessionStorage: window.sessionStorage,
    fetch: block("fetch"),
    setTimeout: (...args) => { const handle = nativeSetTimeout(...args); timers.add(handle); return handle; },
    setInterval: (...args) => { const handle = nativeSetInterval(...args); timers.add(handle); return handle; },
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(async () => {
    release?.();
    await Promise.allSettled([...pending]);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    for (const handle of timers) { nativeClearTimeout(handle); nativeClearInterval(handle); }
    window.close();
    assert.deepEqual(errors, [], "real DOM handlers must not throw");
    assert.deepEqual(externalCalls, [], "no real network, wallet, or unexpected contract activity");
  });

  // DOM dispatch does not await an async listener. Observe its returned promise
  // while still registering and dispatching the real production event handler.
  const form = document.querySelector("#order-form");
  const nativeAdd = form.addEventListener;
  let lastSubmission;
  t.mock.method(form, "addEventListener", function (type, listener, options) {
    if (type !== "submit") return nativeAdd.call(this, type, listener, options);
    return nativeAdd.call(this, type, function (event) {
      lastSubmission = Promise.resolve(listener.call(this, event));
      pending.add(lastSubmission);
    }, options);
  });
  assert.equal(document.hidden, true, "public polling stays disabled in this fixture");
  const moduleUrl = new URL("../../frontend/script.js", import.meta.url);
  moduleUrl.searchParams.set("fixture", String(++fixtureId));
  const { baseMarkets } = await import(moduleUrl.href);
  assert.equal(baseMarkets[0].acceptingPositions, false, "production expired market is unchanged");
  // Replace only this imported fixture's first market with an open synthetic one.
  baseMarkets[0] = { ...baseMarkets[0], marketId: "guard-test", onchainId: 999, title: "Synthetic guard test", acceptingPositions: true };
  document.querySelector("#stake-amount").value = "100";
  document.querySelector("#submit-order").disabled = false;
  const notice = t.mock.fn();
  window.showWalletNotice = notice;
  return {
    document, walletState, placeBet, reducePosition, connect, refreshBalance, notice,
    release: () => release?.(),
    submit() {
      lastSubmission = undefined;
      const event = new window.Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.ok(lastSubmission, "production submit handler must execute");
      return lastSubmission;
    },
  };
}

function assertNoContract(page) {
  assert.equal(page.placeBet.mock.callCount(), 0);
  assert.equal(page.reducePosition.mock.callCount(), 0);
}

function assertNotice(page, message) {
  assert.deepEqual(page.notice.mock.calls.map((call) => call.arguments), [[message, true]]);
}

test("missing address requests connection and never attempts a contract call", async (t) => {
  const page = await loadPage(t, { address: "", balance: 0 });
  await page.submit();
  assertNotice(page, "Connect a funded Freighter Testnet wallet first.");
  assert.equal(page.connect.mock.callCount(), 1);
  assertNoContract(page);
});

test("zero balance shows funding notice before the reserve guard", async (t) => {
  const page = await loadPage(t, { balance: 0 });
  await page.submit();
  assertNotice(page, "Fund your Testnet wallet before placing a position.");
  assert.equal(page.connect.mock.callCount(), 0);
  assertNoContract(page);
});

for (const balance of [100, 100.99]) {
  test(`balance ${balance} cannot leave the required one-XLM reserve`, async (t) => {
    const page = await loadPage(t, { balance });
    await page.submit();
    assertNotice(page, "Leave at least 1 test XLM available for account reserves and fees.");
    assert.equal(page.connect.mock.callCount(), 0);
    assertNoContract(page);
  });
}

for (const balance of [101, 101.01]) {
  test(`balance ${balance} permits one mocked buy with exact trade arguments`, async (t) => {
    const page = await loadPage(t, { balance });
    await page.submit();
    assert.equal(page.notice.mock.callCount(), 0);
    assert.equal(page.placeBet.mock.callCount(), 1);
    assert.equal(page.reducePosition.mock.callCount(), 0);
    assert.equal(page.refreshBalance.mock.callCount(), 1);
    const args = page.placeBet.mock.calls[0].arguments[0];
    assert.equal(args.address, "TEST-WALLET");
    assert.equal(args.marketId, 999);
    assert.equal(args.amountXlm, "100");
    assert.equal(args.isYes, true);
    assert.equal(page.document.querySelector("#submit-order").disabled, false);
  });
}

test("second submit is blocked while the first mocked trade is pending, then cleanup permits another", async (t) => {
  const page = await loadPage(t, { balance: 101, deferred: true });
  const first = page.submit();
  assert.equal(page.placeBet.mock.callCount(), 1, "first real handler reached the deferred mock");
  assert.equal(page.document.querySelector("#submit-order").disabled, true);
  await page.submit();
  assertNotice(page, "A transaction is already in flight for this market. Please wait for confirmation.");
  assert.equal(page.placeBet.mock.callCount(), 1, "second handler must not add a contract call");
  assert.equal(page.reducePosition.mock.callCount(), 0);
  page.release();
  await first;
  assert.equal(page.document.querySelector("#submit-order").disabled, false);
  await page.submit();
  assert.equal(page.placeBet.mock.callCount(), 2, "real finally block cleared in-flight state");
  assert.equal(page.notice.mock.callCount(), 1, "no new guard notice after cleanup");
});

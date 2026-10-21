import { fetchJson } from "./fetch.js";
import { TESTNET, placeBet, reducePosition, checkTransactionStatus } from "./soroban.js";

const contractExplorer = document.querySelector("[data-contract-explorer]");
if (contractExplorer) contractExplorer.href = `https://stellar.expert/explorer/testnet/contract/${TESTNET.predictionMarketContract}`;

const HORIZON_URL = "https://horizon.stellar.org";
const COINGECKO_URL = "https://api.coingecko.com/api/v3";
const POSITION_STORAGE_KEY = "stellartrade:session-positions";
const TESTNET_EXPLORER_PREFIX = `${TESTNET.explorerUrl}/`;

// Never interpolate untrusted session-storage strings into HTML attributes.
function canonicalExplorerUrl(value) {
  if (typeof value !== "string" || !value.startsWith(TESTNET_EXPLORER_PREFIX)) return "";
  const hash = value.slice(TESTNET_EXPLORER_PREFIX.length);
  return hash.length === 64 && /^[0-9a-f]{64}$/.test(hash)
    ? `${TESTNET_EXPLORER_PREFIX}${hash}`
    : "";
}

const state = { price: null, change: null, selectedMarket: 0, action: "buy", outcome: "yes", positions: [] };
export const baseMarkets = [
  { marketId: 3, category: "crypto", title: "Will XLM close above $0.50 by September 30, 2026?", detail: "Deployed Stellar Testnet market #3. Its published close date has passed; the app does not read current settlement state.", yes: 50, volume: "Closed · Testnet", close: "Closed Sep 30, 2026", onchainId: 3, acceptingPositions: false },
  { marketId: "concept-1", category: "network", title: "Will Stellar pass 70 million ledgers this year?", detail: "Product concept. Resolution criteria, oracle, and onchain market are not configured.", yes: 68, volume: "Concept", close: "Example" },
  { marketId: "concept-2", category: "network", title: "Will average ledger close stay below 6 seconds?", detail: "Product concept. Resolution criteria, oracle, and onchain market are not configured.", yes: 76, volume: "Concept", close: "Example" },
  { marketId: "concept-3", category: "crypto", title: "Will XLM gain 10% over the next seven days?", detail: "Product concept. Resolution criteria, oracle, and onchain market are not configured.", yes: 47, volume: "Concept", close: "Example" },
  { marketId: "concept-4", category: "network", title: "Will mainnet process 100+ operations in one ledger?", detail: "Product concept. Resolution criteria, oracle, and onchain market are not configured.", yes: 61, volume: "Concept", close: "Example" },
  { marketId: "concept-5", category: "crypto", title: "Will XLM outperform Bitcoin this month?", detail: "Product concept. Resolution criteria, oracle, and onchain market are not configured.", yes: 43, volume: "Concept", close: "Example" },
];

function parseTransactionHash(url) {
  if (typeof url !== "string" || !url.startsWith(TESTNET_EXPLORER_PREFIX)) return null;
  const hash = url.slice(TESTNET_EXPLORER_PREFIX.length);
  return /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

function loadPositions() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(POSITION_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    const knownMarketIds = new Set(baseMarkets.map((market) => market.marketId));
    return saved.filter((position) => {
      if (!position || typeof position !== "object") return false;
      const validExplorer = position.explorerUrl === undefined || position.explorerUrl === ""
        || canonicalExplorerUrl(position.explorerUrl) === position.explorerUrl;
      const validStatus = !position.status || ["pending", "confirmed", "failed"].includes(position.status);
      const hasKnownMarketId = position.marketId != null && knownMarketIds.has(position.marketId);
      const matchesKnownTitle = baseMarkets.some((m) => m.title === position.title);
      return (hasKnownMarketId || matchesKnownTitle)
        && ["yes", "no"].includes(position.outcome)
        && /^\d{1,4}(\.\d{1,2})?$/.test(position.stake)
        && /^\d{1,8}(\.\d{1,2})?$/.test(position.returns)
        && typeof position.time === "string"
        && /^[0-9: APMapm.]{1,20}$/.test(position.time)
        && validStatus
        && validExplorer;
    }).map((position) => {
      if (position.marketId == null) {
        const match = baseMarkets.find((m) => m.title === position.title);
        if (match) position.marketId = match.marketId;
      }
      return position;
    }).slice(0, 20);
  } catch {
    return [];
  }
}

function savePositions() {
  try {
    sessionStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(state.positions.slice(0, 20)));
  } catch {
    // Storage can be unavailable in private browsing; positions still work in memory.
  }
}

state.positions = loadPositions();

const $ = (selector) => document.querySelector(selector);
const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value);
const formatPrice = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);

function setUpdated() {
  $("#last-updated").textContent = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

async function updateNetwork() {
  try {
    const data = await fetchJson(`${HORIZON_URL}/ledgers?order=desc&limit=1`);
    const ledger = data._embedded.records[0];
    const age = Math.max(0, Math.round((Date.now() - new Date(ledger.closed_at).getTime()) / 1000));
    $("#latest-ledger").textContent = `#${formatNumber(ledger.sequence)}`;
    $("#ledger-age").textContent = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
    $("#operation-count").textContent = formatNumber(ledger.operation_count);
    $("#network-state").textContent = "Live";
    $("#network-state").classList.add("online");
    $("#connection-label").textContent = "Live on Stellar mainnet";
    setUpdated();
  } catch (error) {
    $("#network-state").textContent = "Unavailable";
    $("#connection-label").textContent = "Public data temporarily unavailable";
    console.warn("Stellar network data could not be loaded", error);
  }
}

function renderChart(prices) {
  const values = Array.isArray(prices)
    ? prices.map((point) => point[1]).filter((value) => Number.isFinite(value))
    : [];
  if (values.length === 0) {
    $("#price-chart").innerHTML = '<span class="chart-loading">Price history temporarily unavailable</span>';
    $("#price-range").textContent = "Unavailable";
    return;
  }
  const min = Math.min(...values), max = Math.max(...values), spread = max - min || 1;
  const width = 500, height = 126, pad = 5;
  const plottedValues = values.length === 1 ? [values[0], values[0]] : values;
  const points = plottedValues.map((value, index) => `${(index / (plottedValues.length - 1)) * width},${pad + (1 - (value - min) / spread) * (height - pad * 2)}`).join(" ");
  const area = `0,${height} ${points} ${width},${height}`;
  $("#price-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Seven day XLM price movement"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7df7bd" stop-opacity=".24"/><stop offset="1" stop-color="#7df7bd" stop-opacity="0"/></linearGradient></defs><polyline class="area" points="${area}"/><polyline points="${points}" vector-effect="non-scaling-stroke"/></svg>`;
  $("#price-range").textContent = `${formatPrice(min)} – ${formatPrice(max)}`;
}

async function updatePrice() {
  try {
    const [spot, chart] = await Promise.all([
      fetchJson(`${COINGECKO_URL}/simple/price?ids=stellar&vs_currencies=usd&include_24hr_change=true`),
      fetchJson(`${COINGECKO_URL}/coins/stellar/market_chart?vs_currency=usd&days=7&interval=hourly`),
    ]);
    state.price = spot.stellar.usd;
    const rawChange = spot.stellar.usd_24h_change;
    state.change = typeof rawChange === "number" && Number.isFinite(rawChange) ? rawChange : null;
    $("#xlm-price").textContent = formatPrice(state.price);
    const change = $("#xlm-change");
    change.textContent = state.change === null
      ? "n/a 24h"
      : `${state.change >= 0 ? "+" : ""}${state.change.toFixed(2)}% 24h`;
    change.classList.toggle("negative", state.change !== null && state.change < 0);
    renderChart(chart.prices);
    renderMarkets();
    selectMarket(state.selectedMarket, false);
    setUpdated();
  } catch (error) {
    $("#xlm-change").textContent = "Unavailable";
    $("#price-chart").innerHTML = '<span class="chart-loading">Price feed temporarily unavailable</span>';
    console.warn("XLM price data could not be loaded", error);
  }
}

function renderMarkets(filter = "all") {
  const markets = baseMarkets.map((market) => {
    if (!market.dynamic || !state.price) return market;
    const distance = (state.price - .5) / .5;
    return { ...market, yes: Math.max(8, Math.min(92, Math.round(50 + distance * 50))), detail: `XLM is currently ${formatPrice(state.price)}. Resolves from the CoinGecko daily close.` };
  }).filter((market) => filter === "all" || market.category === filter);
  $("#market-list").innerHTML = markets.map((market) => {
    const index = baseMarkets.findIndex((item) => item.marketId === market.marketId);
    const badge = market.onchainId ? `<span class="market-badge closed">Testnet #${market.onchainId} · closed</span>` : '<span class="market-badge">Concept</span>';
    const action = market.onchainId ? "Inspect market" : "Preview concept";
    return `<article class="market-card"><div class="market-card-header"><span class="category">${market.category}</span>${badge}</div><h3>${market.title}</h3><p>${market.detail}</p><div class="probability" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${market.yes}" aria-valuetext="Sample ${market.yes}% Yes" aria-label="Illustrative probability, not live pool odds"><span style="width:${market.yes}%" aria-hidden="true"></span></div><div class="outcomes"><strong class="yes">Sample ${market.yes}%</strong><strong class="no">Sample ${100 - market.yes}%</strong></div><div class="market-card-action"><div class="market-meta"><span>${market.close}</span></div><button class="trade-link" type="button" data-trade-index="${index}">${action} <svg><use href="#i-arrow" /></svg></button></div></article>`;
  }).join("");
}

function currentMarket() {
  const market = { ...baseMarkets[state.selectedMarket] };
  if (market.dynamic && state.price) {
    market.yes = Math.max(8, Math.min(92, Math.round(50 + ((state.price - .5) / .5) * 50)));
    market.detail = `XLM is currently ${formatPrice(state.price)}. Resolves from the CoinGecko daily close.`;
  }
  return market;
}

function updateOrderPreview() {
  if (state.action === "sell") return;
  const market = currentMarket();
  const probability = state.outcome === "yes" ? market.yes : 100 - market.yes;
  const stake = Math.max(0, Number($("#stake-amount").value) || 0);
  const price = probability / 100;
  const returns = price ? stake / price : 0;
  $("#average-price").textContent = `${price.toFixed(2)} XLM`;
  $("#potential-return").textContent = `${returns.toFixed(2)} XLM`;
  $("#potential-profit").textContent = `${Math.max(0, returns - stake).toFixed(2)} XLM`;
}

function updateTradeAction() {
  const selling = state.action === "sell";
  $("#outcome-fieldset").hidden = selling;
  $("#sell-note").hidden = !selling;
  $("#buy-summary").hidden = selling;
  $("#sell-summary").hidden = !selling;
  $("#amount-label-text").textContent = selling ? "Sell amount" : "Buy amount";
  $("#sell-refund").textContent = currentMarket().onchainId ? "Calculated by contract" : "Simulation only";
  document.querySelectorAll("[data-action]").forEach((button) => {
    const active = button.dataset.action === state.action;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const market = currentMarket();
  const label = $("#submit-order-label");
  if (market.onchainId && !market.acceptingPositions) label.textContent = "Market closed";
  else label.textContent = market.onchainId
    ? (selling ? "Sell position" : "Buy position")
    : (selling ? "Preview sell" : "Preview buy");
  updateOrderPreview();
}

function selectMarket(index, scroll = true) {
  state.selectedMarket = index;
  const market = currentMarket();
  $("#trade-category").textContent = market.category;
  $("#trade-title").textContent = market.title;
  $("#trade-detail").textContent = market.detail;
  $("#trade-close").textContent = market.close;
  $("#trade-probability").textContent = `Sample ${market.yes}% Yes`;
  const probBar = $("#trade-probability-bar");
  probBar.style.width = `${market.yes}%`;
  const probTrack = probBar.closest(".large-probability");
  if (probTrack) {
    probTrack.setAttribute("aria-valuenow", String(market.yes));
    probTrack.setAttribute("aria-valuetext", `Sample ${market.yes}% Yes`);
  }
  $("#yes-price").textContent = `${market.yes}%`;
  $("#no-price").textContent = `${100 - market.yes}%`;
  const orderSubmit = $("#submit-order");
  const mode = $("#trade-mode");
  if (market.onchainId) {
    orderSubmit.disabled = true;
    mode.innerHTML = '<svg><use href="#i-help" /></svg> Closed Testnet market';
    mode.classList.add("live");
    $("#trade-status").textContent = "Close date passed";
    $("#trade-status").classList.remove("online");
    $("#order-disclaimer").textContent = "The published close date has passed. The app does not read settlement status from the contract.";
  } else {
    orderSubmit.disabled = false;
    mode.innerHTML = '<svg><use href="#i-help" /></svg> Simulation mode';
    mode.classList.remove("live");
    $("#trade-status").textContent = "Concept";
    $("#trade-status").classList.remove("online");
    $("#order-disclaimer").textContent = state.action === "sell"
      ? "Preview only. A simulated sell reduces a local demo position; no funds move."
      : "Preview only. No funds move; no live market pool, price, or resolution rules are configured.";
  }
  updateTradeAction();
  if (scroll) $("#trade").scrollIntoView({ behavior: "smooth" });
}

function renderPositions() {
  if (!state.positions.length) return;
  $("#position-list").innerHTML = state.positions.map((position) => {
    const explorerUrl = canonicalExplorerUrl(position.explorerUrl);
    let result;
    if (position.status === "pending") {
      result = explorerUrl
        ? `<a class="position-result pending" href="${explorerUrl}" target="_blank" rel="noreferrer">Pending <svg><use href="#i-external" /></svg></a>`
        : '<span class="position-result pending">Pending</span>';
    } else if (position.status === "failed") {
      result = '<span class="position-result failed">Failed</span>';
    } else if (explorerUrl) {
      result = `<a class="position-result onchain" href="${explorerUrl}" target="_blank" rel="noreferrer">Confirmed <svg><use href="#i-external" /></svg></a>`;
    } else {
      result = '<span class="position-result">Simulated</span>';
    }
    return `<article class="position-card"><div><h3>${position.title}</h3><p>Created ${position.time}</p></div><div class="position-stat"><span>Outcome</span><strong class="${position.outcome}">${position.outcome.toUpperCase()}</strong></div><div class="position-stat"><span>Stake</span><strong>${position.stake} XLM</strong></div><div class="position-stat"><span>Potential return</span><strong>${position.returns} XLM</strong></div>${result}</article>`;
  }).join("");
}

function showToast(message, isError = false) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " toast-error" : ""}`;
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.setAttribute("aria-live", isError ? "assertive" : "polite");
  toast.innerHTML = '<svg aria-hidden="true"><use href="#i-check" /></svg><span></span>';
  toast.querySelector("span").textContent = String(message);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

window.showWalletNotice = (message, isError = false) => {
  showToast(message, isError);
};

const inFlightMarkets = new Set();

const activeReconciliations = new WeakSet();

function reconcilePendingPosition(position) {
  if (!position?.hash || position.status !== "pending" || activeReconciliations.has(position)) return;
  activeReconciliations.add(position);
  let attempts = 0;
  let pollTimer = null;
  let pollActive = false;

  function stop() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    activeReconciliations.delete(position);
  }

  async function poll() {
    if (document.hidden || pollActive) return;
    if (attempts >= 30 || position.status !== "pending") {
      stop();
      return;
    }
    attempts += 1;
    pollActive = true;
    try {
      const res = await checkTransactionStatus(position.hash);
      if (res?.status === "SUCCESS") {
        position.status = "confirmed";
        savePositions();
        renderPositions();
        stop();
        window.stellarWallet?.refreshBalance().catch(() => {});
        showToast("Pending position confirmed on Stellar Testnet!");
      } else if (res?.status === "FAILED") {
        position.status = "failed";
        savePositions();
        renderPositions();
        stop();
      }
    } catch {
      // transient network poll error
    } finally {
      pollActive = false;
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    } else if (position.status !== "pending") {
      stop();
    } else if (pollTimer === null) {
      pollTimer = setInterval(poll, 2000);
      void poll();
    }
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  onVisibilityChange();
}

document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active"); renderMarkets(button.dataset.filter);
}));

$("#market-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-trade-index]");
  if (button) selectMarket(Number(button.dataset.tradeIndex));
});

document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
  state.action = button.dataset.action;
  const market = currentMarket();
  if (!market.onchainId) {
    $("#order-disclaimer").textContent = state.action === "sell"
      ? "Preview only. A simulated sell reduces a local demo position; no funds move."
      : "Preview only. No funds move; no live market pool, price, or resolution rules are configured.";
  }
  updateTradeAction();
}));

document.querySelectorAll("[data-outcome]").forEach((button) => button.addEventListener("click", () => {
  state.outcome = button.dataset.outcome;
  document.querySelectorAll("[data-outcome]").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  updateOrderPreview();
}));
$("#stake-amount").addEventListener("input", updateOrderPreview);
document.querySelectorAll("[data-amount]").forEach((button) => button.addEventListener("click", () => { $("#stake-amount").value = button.dataset.amount; updateOrderPreview(); }));

$("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const requestedStake = Number($("#stake-amount").value);
  if (!Number.isFinite(requestedStake) || requestedStake < 1 || requestedStake > 1000) {
    window.showWalletNotice("Enter a stake between 1 and 1000 XLM. No order was submitted.", true);
    return;
  }
  const stake = requestedStake;
  const market = currentMarket();
  if (market.onchainId && !market.acceptingPositions) {
    window.showWalletNotice("This Testnet market passed its published close date. Buys and sells are unavailable.", true);
    return;
  }
  const probability = state.outcome === "yes" ? market.yes : 100 - market.yes;
  const position = {
    marketId: market.marketId,
    title: market.title,
    outcome: state.outcome,
    stake: stake.toFixed(0),
    returns: (stake / (probability / 100)).toFixed(2),
    time: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date()),
  };

  if (!market.onchainId) {
    if (state.action === "sell") {
      const openPosition = [...state.positions].reverse().find((item) => item.marketId === market.marketId && !item.hash && (!item.status || item.status === "simulated"));
      if (!openPosition) {
        window.showWalletNotice("There is no simulated position to sell for this market.", true);
        return;
      }
      const remaining = Number(openPosition.stake) - stake;
      if (remaining < 0) {
        window.showWalletNotice(`You can sell up to ${openPosition.stake} XLM from this simulated position.`, true);
        return;
      }
      if (remaining === 0) {
        state.positions.splice(state.positions.indexOf(openPosition), 1);
      } else {
        const originalStake = Number(openPosition.stake);
        openPosition.stake = remaining.toFixed(0);
        openPosition.returns = (Number(openPosition.returns) * remaining / originalStake).toFixed(2);
      }
      savePositions();
      renderPositions();
      showToast("Simulated position reduced. No funds moved.");
      return;
    }
    state.positions.unshift(position);
    savePositions();
    renderPositions();
    showToast("Position added to your simulation dashboard.");
    $("#activity").scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (inFlightMarkets.has(market.onchainId)) {
    window.showWalletNotice("A transaction is already in flight for this market. Please wait for confirmation.", true);
    return;
  }

  const wallet = window.stellarWallet;
  const walletState = wallet?.getState();
  if (!walletState?.address) {
    window.showWalletNotice("Connect a funded Freighter Testnet wallet first.", true);
    await wallet?.connect();
    return;
  }
  if (state.action === "buy" && walletState.balance === 0) {
    window.showWalletNotice("Fund your Testnet wallet before placing a position.", true);
    return;
  }
  if (state.action === "buy" && Number.isFinite(walletState.balance) && stake + 1 > walletState.balance) {
    window.showWalletNotice("Leave at least 1 test XLM available for account reserves and fees.", true);
    return;
  }

  const submit = $("#submit-order");
  const action = state.action;
  const label = submit.querySelector("span");
  const originalLabel = label.textContent;
  submit.disabled = true;
  document.querySelectorAll("[data-action], [data-outcome]").forEach((button) => { button.disabled = true; });
  inFlightMarkets.add(market.onchainId);

  let pendingPosition = null;
  let pendingSell = null;

  try {
    const submitTrade = action === "sell" ? reducePosition : placeBet;
    const tradeArguments = {
      address: walletState.address,
      marketId: market.onchainId,
      amountXlm: String(stake),
      signTransaction: wallet.signTransaction,
      onStatus: (status) => { label.textContent = status; },
      onSubmitted: ({ hash, explorerUrl }) => {
        if (action === "sell") {
          pendingSell = { hash, explorerUrl };
          showToast("Sell submitted to Testnet. Waiting for confirmation...");
        } else {
          pendingPosition = {
            ...position,
            status: "pending",
            hash,
            explorerUrl,
            marketId: market.marketId,
          };
          state.positions.unshift(pendingPosition);
          savePositions();
          renderPositions();
          showToast("Buy submitted to Testnet. Waiting for confirmation...");
        }
      },
    };
    if (action === "buy") tradeArguments.isYes = state.outcome === "yes";
    const transaction = await submitTrade(tradeArguments);

    if (action === "buy") {
      if (pendingPosition) {
        pendingPosition.status = "confirmed";
        pendingPosition.hash = transaction.hash;
        pendingPosition.explorerUrl = transaction.explorerUrl;
      } else {
        state.positions.unshift({
          ...position,
          status: "confirmed",
          explorerUrl: transaction.explorerUrl,
          hash: transaction.hash,
          marketId: market.marketId,
        });
      }
      savePositions();
      renderPositions();
    }
    await wallet.refreshBalance();
    showToast(action === "sell" ? "Sell confirmed. The contract returned the calculated refund." : "Buy confirmed on Stellar Testnet.");
    $("#activity").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    if (error?.name === "TransactionTimeoutError" || error?.explorerUrl) {
      const explorerUrl = error.explorerUrl || pendingPosition?.explorerUrl;
      const hash = error.hash || pendingPosition?.hash;
      if (pendingPosition) {
        pendingPosition.status = "pending";
        pendingPosition.hash = hash;
        pendingPosition.explorerUrl = explorerUrl;
        savePositions();
        renderPositions();
        reconcilePendingPosition(pendingPosition);
      }
      if (pendingPosition) {
        window.showWalletNotice("Buy is still confirming on Stellar Testnet. It is recorded as pending in your positions.", false);
      } else if (pendingSell) {
        window.showWalletNotice(`Sell is still confirming on Stellar Testnet: ${pendingSell.explorerUrl}`, false);
      } else {
        window.showWalletNotice(error?.message || "The transaction is still confirming on Stellar Testnet.", false);
      }
      $("#activity").scrollIntoView({ behavior: "smooth" });
    } else {
      if (pendingPosition) {
        const idx = state.positions.indexOf(pendingPosition);
        if (idx !== -1) {
          state.positions.splice(idx, 1);
          savePositions();
          renderPositions();
        }
      }
      window.showWalletNotice(error?.message || "The Testnet position could not be submitted.", true);
    }
  } finally {
    inFlightMarkets.delete(market.onchainId);
    submit.disabled = false;
    document.querySelectorAll("[data-action], [data-outcome]").forEach((button) => { button.disabled = false; });
    label.textContent = originalLabel;
  }
});

document.querySelectorAll("[data-dashboard]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-dashboard]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  const showPositions = button.dataset.dashboard === "positions";
  $("#positions-view").hidden = !showPositions;
  $("#feed-view").hidden = showPositions;
}));

const menuButton = $(".menu-button");
const siteNav = $("#main-navigation");

function setMenuOpen(open, returnFocus = false) {
  siteNav.classList.toggle("open", open);
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  if (open) requestAnimationFrame(() => siteNav.querySelector("a")?.focus());
  else if (returnFocus) menuButton.focus();
}

menuButton.addEventListener("click", () => setMenuOpen(!siteNav.classList.contains("open")));
siteNav.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setMenuOpen(false)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && siteNav.classList.contains("open")) setMenuOpen(false, true);
});
document.addEventListener("pointerdown", (event) => {
  if (siteNav.classList.contains("open") && !event.target.closest(".nav-wrap")) setMenuOpen(false);
});
window.matchMedia("(min-width: 681px)").addEventListener("change", (event) => {
  if (event.matches) setMenuOpen(false);
});

$("#year").textContent = new Date().getFullYear();
renderMarkets();
selectMarket(0, false);
renderPositions();
state.positions.filter((p) => p.status === "pending" && p.hash).forEach(reconcilePendingPosition);
// Background tabs should not spend public Horizon or CoinGecko rate limits.
let networkPollTimer = null;
let pricePollTimer = null;

function stopPublicPolling() {
  if (networkPollTimer !== null) clearInterval(networkPollTimer);
  if (pricePollTimer !== null) clearInterval(pricePollTimer);
  networkPollTimer = null;
  pricePollTimer = null;
}

function startPublicPolling() {
  if (document.hidden || networkPollTimer !== null) return;
  void updateNetwork();
  void updatePrice();
  networkPollTimer = setInterval(() => { if (!document.hidden) void updateNetwork(); }, 10000);
  pricePollTimer = setInterval(() => { if (!document.hidden) void updatePrice(); }, 60000);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPublicPolling();
  else startPublicPolling();
});
startPublicPolling();

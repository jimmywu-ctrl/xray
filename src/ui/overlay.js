/* X-ray overlay — monitored tokens */
(function () {
  "use strict";

  var T = {
    searchPh: "\u641c\u7d22\u4ee3\u5e01\u540d / CA",
    colToken: "\u4ee3\u5e01 / KOL",
    peakMultipleSort: "\u5cf0\u503c\u00d7",
    colMc: "\u5e02\u503c / \u558a\u540e",
    listen: "\u76d1\u542c ",
    groupsEtc: " \u7b49 ",
    groups: " \u7fa4",
    tokens: " \u4ee3\u5e01",
    noGroups: "\u672a\u76d1\u542c\u7fa4\u7ec4",
    ellipsis: "\u2026",
    connecting: "\u8fde\u63a5\u4e2d",
    connected: "\u5df2\u8fde\u63a5",
    reconnecting: "\u91cd\u8fde\u4e2d",
    disconnected: "\u5df2\u65ad\u5f00",
    failed: "\u5931\u8d25",
    emptyWait: "\u7b49\u5f85\u7fa4\u91cc\u51fa\u73b0\u5408\u7ea6\u5730\u5740\u2026",
    emptyNoMatchPre: "\u6ca1\u6709\u5339\u914d\u300c",
    emptyNoMatchPost: "\u300d\u7684\u4ee3\u5e01",
    emptyOffline: "\u672a\u8fde\u63a5 sidecar",
    agoSuffix: "\u524d",
    dash: "\u2014",
    emptyNoSources: "\u8fd8\u6ca1\u914d\u7f6e\u5fae\u4fe1 / \u98de\u4e66\u7fa4\u6765\u6e90 \u00b7 \u53bb\u8bbe\u7f6e",
    labelTitle: "\u6539\u6807\u7b7e",
    labelRaw: "\u539f\u540d",
    labelPh: "\u663e\u793a\u540d\u6807\u7b7e",
    labelSave: "\u4fdd\u5b58",
    labelClear: "\u6e05\u9664",
    labelCancel: "\u53d6\u6d88",
  };

  var els = {
    panel: document.getElementById("panel"),
    liveLabel: document.getElementById("live-label"),
    clock: document.getElementById("hud-clock"),
    footer: document.querySelector(".footer"),
    subDot: document.getElementById("sub-dot"),
    subtitle: document.getElementById("subtitle"),
    eq: document.getElementById("eq"),
    search: document.getElementById("search"),
    searchCount: document.getElementById("search-count"),
    searchClear: document.getElementById("search-clear"),
    caQuery: document.getElementById("ca-query"),
    caQueryChain: document.getElementById("ca-query-chain"),
    caQueryRun: document.getElementById("ca-query-run"),
    caQueryStatus: document.getElementById("ca-query-status"),
    caQueryPair: document.getElementById("ca-query-pair"),
    caQueryResult: document.getElementById("ca-query-result"),
    caQueryTitle: document.getElementById("ca-query-title"),
    caQueryPrice: document.getElementById("ca-query-price"),
    caQueryMc: document.getElementById("ca-query-mc"),
    caQueryLiquidity: document.getElementById("ca-query-liquidity"),
    caQueryHolders: document.getElementById("ca-query-holders"),
    caQueryTime: document.getElementById("ca-query-time"),
    caQueryWarning: document.getElementById("ca-query-warning"),
    cols: document.getElementById("cols"),
    sortMultiple: document.getElementById("sort-multiple"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    ftDot: document.getElementById("ft-dot"),
    ftLink: document.getElementById("ft-link"),
    btnHide: document.getElementById("btn-hide"),
    collapsedLogo: document.getElementById("collapsed-logo"),
    btnMuted: document.getElementById("btn-muted"),
    mutedLabel: document.getElementById("muted-label"),
    mutedMenu: document.getElementById("muted-menu"),
    mutedList: document.getElementById("muted-list"),
    mutedStatus: document.getElementById("muted-status"),
    btnSettings: document.getElementById("btn-settings"),
    labelModal: document.getElementById("label-modal"),
    labelModalError: document.getElementById("label-modal-error"),
    labelBackdrop: document.getElementById("label-modal-backdrop"),
    labelHd: document.getElementById("label-modal-hd"),
    labelRawK: document.getElementById("label-modal-raw-k"),
    labelRawV: document.getElementById("label-modal-raw-v"),
    labelInput: document.getElementById("label-modal-input"),
    labelSave: document.getElementById("label-modal-save"),
    labelClear: document.getElementById("label-modal-clear"),
    labelCancel: document.getElementById("label-modal-cancel"),
  };

  els.search.placeholder = T.searchPh;
  els.cols.querySelector(".c-left").textContent = T.colToken;
  els.cols.querySelector(".c-right").textContent = T.colMc;
  els.ftLink.textContent = T.connecting;
  els.empty.textContent = T.emptyOffline;
  if (els.labelHd) els.labelHd.textContent = T.labelTitle;
  if (els.labelRawK) els.labelRawK.textContent = T.labelRaw;
  if (els.labelSave) els.labelSave.textContent = T.labelSave;
  if (els.labelClear) els.labelClear.textContent = T.labelClear;
  if (els.labelCancel) els.labelCancel.textContent = T.labelCancel;
  if (els.labelInput) els.labelInput.placeholder = T.labelPh;

  function savedPeakMultipleSort() {
    try {
      var value = localStorage.getItem("fomomo.peakMultipleSort.v3");
      if (value === "desc" || value === "asc" || value === "off") return value;
      value = localStorage.getItem("fomomo.peakMultipleSort") || localStorage.getItem("fomomo.callMultipleSort");
      return value === "desc" || value === "asc" || value === "off" ? value : "off";
    } catch (e) { return "off"; }
  }

  var state = {
    tokens: [],
    visibleTokens: [],
    virtualStart: -1,
    virtualEnd: -1,
    query: "",
    peakMultipleSort: savedPeakMultipleSort(),
    link: "connecting",
    groups: [],
    message: null,
    now: Date.now() / 1000,
    freshID: null,
    sourcesConfigured: null,
    dashboardUrl: true,
    callerLabels: {},
    labelEditRaw: null,
    selectedToken: null,
    mutedTokens: [],
  };
  var reportedLogoFailures = new Set();
  var gmgnToastTimer = null;

  function $(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function showGmgnToast(message) {
    var toast = document.getElementById("overlay-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(gmgnToastTimer);
    gmgnToastTimer = setTimeout(function () { toast.hidden = true; }, 4500);
  }

  function openGmgnFromRow(token, address) {
    if (!window.fomomo || !window.fomomo.openTokenGmgn) return;
    Promise.resolve(window.fomomo.openTokenGmgn(pickChain(token), address)).then(function (result) {
      if (result && result.fallback) {
        showGmgnToast(result.copied
          ? "链暂未识别，CA 已复制；已打开 GMGN，请粘贴搜索"
          : "链暂未识别，已打开 GMGN；请复制 CA 后搜索");
      }
    }).catch(function (error) {
      showGmgnToast("打开 GMGN 失败：" + String(error && error.message || error || "未知错误"));
    });
  }

  function svg(name, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", name);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function personIcon() {
    var s = svg("svg", { viewBox: "0 0 16 16", width: "10", height: "10" });
    s.appendChild(svg("path", {
      d: "M6 7a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 6 7zm5.2-.4a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM2.2 13.2c0-2 2-3.2 3.8-3.2s3.8 1.2 3.8 3.2v.4H2.2v-.4zm8.2-2.8c.4-.2.9-.3 1.4-.3 1.5 0 2.8.9 2.8 2.4v.4h-3.2",
      fill: "currentColor",
    }));
    return s;
  }


  /* Keep in sync with the sidecar token formatting. */
  function fmtCompact(v) {
    if (v == null || !Number.isFinite(v)) return T.dash;
    var a = Math.abs(v);
    function f(x, s) {
      return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + s;
    }
    if (a >= 1e9) return "$" + f(a / 1e9, "B");
    if (a >= 1e6) return "$" + f(a / 1e6, "M");
    if (a >= 1e3) return "$" + f(a / 1e3, "K");
    return "$" + a.toFixed(0);
  }

  function fmtAgoShort(ts, now) {
    /* Zero is a valid Unix timestamp; still show the short relative time. */
    if (ts == null || !Number.isFinite(ts)) return null;
    var s = Math.max(0, Math.floor(now - ts));
    if (s < 60) return s + "\u79d2";
    if (s < 3600) return Math.floor(s / 60) + "\u5206";
    if (s < 86400) return Math.floor(s / 3600) + "\u65f6";
    return Math.floor(s / 86400) + "\u5929";
  }

  /* Chain badge colors. */
  function chainMeta(chain) {
    var c = String(chain || "").toLowerCase();
    if (!c || c === "?" || c === "unknown") return { label: "?", cls: "q" };
    if (c === "robinhood" || c === "rh") return { label: "RH", cls: "rh" };
    if (c === "bsc" || c === "bnb") return { label: "BSC", cls: "bsc" };
    if (c === "sol" || c === "solana") return { label: "SOL", cls: "sol" };
    if (c === "eth" || c === "ethereum") return { label: "ETH", cls: "eth" };
    if (c === "base") return { label: "BASE", cls: "base" };
    if (c === "monad" || c === "mon") return { label: "MON", cls: "monad" };
    if (c === "arc") return { label: "ARC", cls: "arc" };
    return { label: c.toUpperCase(), cls: "other" };
  }

  function formatMultiple(value) {
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function peakBadgeData(t, baseline) {
    if (!t || t.statsExcluded === true) return null;
    var confirmed = t.confirmedPeakX != null && Number.isFinite(Number(t.confirmedPeakX)) && Number(t.confirmedPeakX) > 0
      ? Number(t.confirmedPeakX) : null;
    var value = pickPeakMultiple(t);
    if (value != null) {
      return {
        value: value,
        estimated: t.peakApprox === true || confirmed == null || value > confirmed,
      };
    }
    var shoutAt = baseline && baseline.time != null ? Number(baseline.time) : null;
    var hasBaseline = !!baseline && ((baseline.marketCap != null && Number(baseline.marketCap) > 0) || (baseline.price != null && Number(baseline.price) > 0));
    if (Number(t.kol) > 0 && shoutAt != null && Number.isFinite(shoutAt) && state.now - shoutAt <= 5 * 60) {
      return { pending: hasBaseline ? "待高点" : "待基准" };
    }
    return null;
  }

  /* FM.logoGradient — HSB → CSS hsl approximation */
  function logoGradient(symbol) {
    var h = 0;
    var s = symbol || "?";
    for (var i = 0; i < s.length; i++) h = Math.imul(h, 31) + s.charCodeAt(i) | 0;
    var base = 152 + ((h % 60) - 30);
    var h1 = ((base % 360) + 360) % 360;
    var h2 = (((base + 34) % 360) + 360) % 360;
    /* HSB(s=0.85,b=0.62) → ~hsl(74%,36%); HSB(s=0.80,b=0.44) → ~hsl(67%,26%) */
    return "linear-gradient(135deg, hsl(" + h1 + " 74% 36%), hsl(" + h2 + " 67% 26%))";
  }

  function shortAddr(addr) {
    if (!addr) return "?";
    if (addr.length <= 10) return addr;
    return addr.slice(0, 6) + "\u2026" + addr.slice(-4);
  }

  function pickMarket(t) { return t.market || null; }
  function pickSymbol(t) {
    var m = pickMarket(t);
    return String((m && m.symbol) || t.symbol || "").trim();
  }
  function pickResolved(t) {
    var m = pickMarket(t);
    return !!(m && m.symbol);
  }
  function pickChain(t) {
    var m = pickMarket(t);
    var c = (m && m.chain) || t.chainHint || t.chain || "";
    return String(c).toLowerCase() || "?";
  }
  function pickTokenKey(t) { return String(t && t.key || (pickChain(t) + ":" + pickAddr(t))); }
  function pickMc(t) {
    var m = pickMarket(t);
    var v = m && m.mc != null ? m.mc : m && m.fdv != null ? m.fdv : t.mc;
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  }
  function pickChange(t) {
    if (t.change != null && Number.isFinite(Number(t.change))) return Number(t.change);
    return null;
  }
  var observedSortPeaks = new Map();
  function pickPeakMultiple(t) {
    if (!t || t.statsExcluded === true) return null;
    var key = pickTokenKey(t);
    var context = String(t.changeBasePrice) + ':' + String(t.changeBaseSource);
    var previous = observedSortPeaks.get(key);
    var values = [t.peakSortX, t.confirmedPeakX, t.referencePeakX, t.liveHighX, t.currentMultiple]
      .filter(function (v) { return v != null && Number.isFinite(Number(v)) && Number(v) > 0; }).map(Number);
    if (previous && previous.context === context) values.push(previous.value);
    if (!values.length) return null;
    var value = Math.max.apply(Math, values);
    observedSortPeaks.set(key, { context: context, value: value });
    return value;
  }
           function pickSpark(t) {
    var s = t.spark;
    return Array.isArray(s) ? s.map(Number).filter(Number.isFinite) : [];
  }
  function pickKol(t) {
    var n = Number(t.kol);
    return Number.isFinite(n) ? n : 0;
  }
    /** Unique WeChat senders in first-mention order (TokenView.mentions[].sender). */
  function pickCallers(t) {
    var mentions = Array.isArray(t.mentions) ? t.mentions : [];
    var seen = Object.create(null);
    var names = [];
    for (var i = 0; i < mentions.length; i++) {
      var s = mentions[i] && mentions[i].sender;
      if (s == null || s === "") continue;
      s = String(s);
      if (seen[s]) continue;
      seen[s] = 1;
      names.push(s);
    }
    return names;
  }
  function pickChannelSources(t) {
    var mentions = Array.isArray(t.mentions) ? t.mentions : [];
    var seen = Object.create(null);
    var names = [];
    for (var i = 0; i < mentions.length; i++) {
      var mention = mentions[i];
      var name = mention && mention.isChannelCall && mention.channelTitle;
      if (!name || seen[name]) continue;
      seen[name] = 1;
      names.push(String(name));
    }
    return names;
  }
  function callerLabelOf(raw) {
    var map = state.callerLabels || {};
    var v = map[raw];
    if (v == null) return "";
    v = String(v).trim();
    return v;
  }
  function callerDisplayItem(raw) {
    var label = callerLabelOf(raw);
    if (label) return { raw: raw, display: label, tagged: true };
    return { raw: raw, display: raw, tagged: false };
  }
  function callerTitlePart(item) {
    if (item.tagged) return item.display;
    return item.raw;
  }
  /** Up to 2 names; more -> A · B 等N (N = unique raw count). title = full list. */
  function formatCallers(names) {
    var mid = "\u00b7";
    if (!names.length) return { items: [], more: 0, title: "", text: "0", numeric: true };
    var items = names.map(callerDisplayItem);
    var title = items.map(callerTitlePart).join(" " + mid + " ");
    // Keep saved caller labels visible even when several people mention a token. This only changes presentation.
    var tagged = items.filter(function (item) { return item.tagged; });
    var ordinary = items.filter(function (item) { return !item.tagged; });
    var show = tagged.concat(ordinary).slice(0, 2);
    var more = items.length > 2 ? items.length : 0;
    var textParts = show.map(function (it) { return it.display; });
    var text = textParts.join(" " + mid + " ");
    if (more) text = text + " \u7b49" + more;
    return { items: show, more: more, title: title, text: text, numeric: false, total: items.length };
  }
  function pickFirstSeen(t) {
    var v = Number(t.firstSeen);
    return Number.isFinite(v) ? v : null;
  }
  function pickCallBaseline(t) {
    var mentions = Array.isArray(t.mentions) ? t.mentions : [];
    // The engine inserts the first human shout even when it has no price yet.
    // Do not silently move ownership to a later caller with a more complete quote.
    var base = mentions[0] || null;
    var marketCap = base && base.mc != null && Number.isFinite(Number(base.mc)) && Number(base.mc) > 0 ? Number(base.mc) : null;
    var time = base && base.time != null && Number.isFinite(Number(base.time)) ? Number(base.time) : pickFirstSeen(t);
    return {
      marketCap: marketCap, time: time, approximate: !!(base && base.approx),
      price: base && base.price != null ? Number(base.price) : null,
      priceSource: base && base.priceSource || null,
      mcSource: base && base.mcSource || null,
      mcBasis: base && base.mcBasis || null,
      pricePrecision: base && base.pricePrecision || "unknown",
      mcPrecision: base && base.mcPrecision || "unknown",
      priceAt: base && base.priceAt != null ? Number(base.priceAt) : null,
      quoteAt: base && base.quoteAt != null ? Number(base.quoteAt) : null,
      receivedAt: base && base.receivedAt != null ? Number(base.receivedAt) : null,
      poolId: base && base.poolId || null,
      endpoint: base && base.endpoint || null,
    };
  }
  function exactTimeTitle(ts) {
    var v = Number(ts);
    if (!Number.isFinite(v)) return "未知";
    return new Date(v * 1000).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function pickAddr(t) {
    var address = String(t.address || "");
    return /^0x/i.test(address) ? address.toLowerCase() : address;
  }
  function pickLogo(t) {
    var m = pickMarket(t);
    return (m && m.logo) || t.logo || null;
  }
  function pickName(t) {
    var m = pickMarket(t);
    return String((m && m.name) || t.name || "");
  }

  /* KLineView — points already 0..1; live=false → dashed faint */
  function sparkSvg(points, up, live) {
    var w = 54, h = 26;
    var s = svg("svg", { viewBox: "0 0 " + w + " " + h, width: String(w), height: String(h) });
    var col = live ? (up ? "#3ddc84" : "#ff5b5b") : "#565c61";
    var pts = points && points.length >= 2 ? points.slice() : [0.5, 0.5];
    var n = pts.length;
    var coords = pts.map(function (p, i) {
      var y = Math.max(0, Math.min(1, p));
      return [w * i / (n - 1), h - h * y];
    });
    var line = coords.map(function (c, i) {
      return (i ? "L" : "M") + c[0].toFixed(2) + " " + c[1].toFixed(2);
    }).join(" ");
    if (live) {
      var area = line +
        " L" + coords[coords.length - 1][0].toFixed(2) + " " + h.toFixed(2) +
        " L" + coords[0][0].toFixed(2) + " " + h.toFixed(2) + " Z";
      var gid = "sg" + Math.random().toString(36).slice(2, 8);
      var defs = svg("defs");
      var lg = svg("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
      lg.appendChild(svg("stop", { offset: "0%", "stop-color": col, "stop-opacity": "0.26" }));
      lg.appendChild(svg("stop", { offset: "100%", "stop-color": col, "stop-opacity": "0" }));
      defs.appendChild(lg);
      s.appendChild(defs);
      s.appendChild(svg("path", { d: area, fill: "url(#" + gid + ")" }));
    }
    s.appendChild(svg("path", {
      d: line, fill: "none", stroke: col,
      "stroke-width": live ? "1.6" : "1",
      "stroke-linecap": "round", "stroke-linejoin": "round",
      "stroke-dasharray": live ? "none" : "2 3",
    }));
    return s;
  }

  function makeLogo(symbol, logoUrl, sizeCls, token) {
    var letter = String(symbol || "?").charAt(0).toUpperCase() || "?";
    var av = $(sizeCls === "h" ? "div" : "div", sizeCls === "h" ? "h-avatar" : "avatar", letter);
    av.style.background = logoGradient(symbol || "?");
    var failedUrls = token && token.logoLookup && Array.isArray(token.logoLookup.failedUrls)
      ? token.logoLookup.failedUrls : [];
    if (logoUrl && failedUrls.indexOf(String(logoUrl).trim()) < 0) {
      var img = document.createElement("img");
      var sourceUrl = String(logoUrl);
      img.src = "/api/avatar-image?src=" + encodeURIComponent(sourceUrl);
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", function () {
        img.remove();
        var chain = pickChain(token), address = pickAddr(token), key = chain + ":" + address + ":" + sourceUrl;
        if (!reportedLogoFailures.has(key) && window.fomomoDashboard && window.fomomoDashboard.reportOverlayLogoFailure) {
          reportedLogoFailures.add(key);
          window.fomomoDashboard.reportOverlayLogoFailure(chain, address, sourceUrl).catch(function () {});
        }
      });
      av.appendChild(img);
    }
    return av;
  }

  function buildRow(t) {
    var resolved = pickResolved(t);
    var addr = pickAddr(t);
    var sym = pickSymbol(t);
    var display = resolved ? sym : shortAddr(addr);
    var chain = pickChain(t);
    var cm = chainMeta(chain);
    var kol = pickKol(t);
    var firstSeen = pickFirstSeen(t);
    var callBaseline = pickCallBaseline(t);
    var logo = pickLogo(t);

    var row = $("div", "row");
    row._token = t;
    row.style.cursor = "pointer";
    row.title = "在 Chrome 中打开 GMGN";
    row.setAttribute("role", "link");
    row.tabIndex = 0;
    row.addEventListener("click", function (e) {
      if (e.target.closest("button,a,input,select,textarea")) return;
      openGmgnFromRow(row._token, pickAddr(row._token));
    });
    row.addEventListener("keydown", function (e) {
      if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      openGmgnFromRow(row._token, pickAddr(row._token));
    });
    if (t.fresh || (state.freshID && pickTokenKey(t) === String(state.freshID))) row.classList.add("fresh");
    if (state.selectedToken && state.selectedToken.key === pickTokenKey(t)) row.classList.add("selected");
    var left = $("div", "cell-left");
    left.appendChild(makeLogo(resolved ? sym : display, logo, "t", t));
    var meta = $("div", "meta");
    var symRow = $("div", "sym-row");
    var symEl = $("span", "sym" + (resolved ? "" : " addr") + " sym-link", display);
    symRow.appendChild(symEl);
    var chainCorner = $("span", "chain chain-corner " + cm.cls, cm.label);
    var iconKey = ({ solana:"sol", ethereum:"eth", bnb:"bsc", robinhood:"rh", avalanchec:"avalanche", x_layer:"xlayer", "x-layer":"xlayer" })[String(chain).toLowerCase()] || String(chain).toLowerCase();
    var chainIcons = ["sol","bsc","eth","base","rh","arbitrum","polygon","avalanche","optimism","tron","sui","ton","monad","xlayer"];
    if (chainIcons.indexOf(iconKey) >= 0) {
      chainCorner.textContent = "";
      chainCorner.classList.add("chain-icon");
      chainCorner.classList.add("chain-" + iconKey);
      if (iconKey === "rh") chainCorner.classList.add("rh-icon");
      var chainImg = document.createElement("img");
      chainImg.src = "assets/chains/" + iconKey + (["rh", "xlayer", "sol", "bsc"].indexOf(iconKey) >= 0 ? ".svg" : ".png");
      chainImg.alt = cm.label;
      chainImg.addEventListener("error", function () { chainCorner.textContent = cm.label; });
      chainCorner.appendChild(chainImg);
    }
    chainCorner.title = "链：" + cm.label;
    left.appendChild(chainCorner);
    var callers = pickCallers(t);
    var priorityCallers = callers.map(function (raw) {
      return { raw: raw, label: callerLabelOf(raw) };
    }).filter(function (item) { return !!item.label; });
    if (priorityCallers.length) {
      row.classList.add("labeled-caller");
      row.title = "已标记喊单人发出的 CA";
    }
    var callFmt = formatCallers(callers);
    if (!callers.length && kol > 0) {
      callFmt = { items: [], more: 0, title: String(kol), text: String(kol), numeric: true };
    } else if (!callers.length) {
      callFmt = { items: [], more: 0, title: "", text: "0", numeric: true };
    }
    var kolRow = $("div", "kol-row");
    var channelSources = pickChannelSources(t);
    if (channelSources.length) {
      row.classList.add("channel-call");
      var channelBadge = $("span", "channel-call-badge", "频道");
      channelBadge.title = "频道喊单来源：" + channelSources.join("、");
      channelBadge.setAttribute("aria-label", "频道喊单");
      kolRow.appendChild(channelBadge);
    }
    var kolEl = $("span", "kol");
    kolEl.appendChild(personIcon());
    var namesEl = $("span", "kol-names");
    if (callFmt.numeric || !callFmt.items.length) {
      namesEl.textContent = callFmt.text;
    } else {
      var mid = "\u00b7";
      var anyTagged = false;
      for (var ci = 0; ci < callFmt.items.length; ci++) {
        if (ci > 0) namesEl.appendChild($("span", "kol-mid", " " + mid + " "));
        (function (item) {
          var span = $("button", "kol-name" + (item.tagged ? " tagged" : ""), item.display); span.type = "button"; span.setAttribute("aria-label", "设置 " + item.display + " 的备注");
          span.dataset.raw = item.raw;
          span.title = callerTitlePart(item);
          span.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            openLabelModal(item.raw);
          });
          namesEl.appendChild(span);
          if (item.tagged) anyTagged = true;
        })(callFmt.items[ci]);
      }
      if (callFmt.more) namesEl.appendChild($("span", "kol-more", " \u7b49" + callFmt.more));
      if (anyTagged) namesEl.classList.add("tagged");
    }
    if (callFmt.title) namesEl.title = callFmt.title;
    kolEl.appendChild(namesEl);
    kolEl.title = callFmt.title || "";
    if (!callFmt.numeric && callFmt.items.length === 1) {
      kolEl.style.cursor = "pointer";
      kolEl.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openLabelModal(callFmt.items[0].raw);
      });
    }
    kolRow.appendChild(kolEl);
    var muteButton=$("button","token-mute");
    muteButton.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 8 9 8 9s8-4.5 8-9V6l-8-3Z"/><path d="m9 9 6 6m0-6-6 6"/></svg>';
    muteButton.setAttribute("aria-label","屏蔽此代币");
    muteButton.type="button";
    muteButton.title="仅隐藏此代币，不影响数据库统计";
    muteButton.addEventListener("click",function(event){
      event.preventDefault();event.stopPropagation();muteButton.disabled=true;
      var t = row._token;
      Promise.resolve(window.fomomo.setMonitorMuted({address:t.address,chain:t.chain||t.chainHint||(t.market&&t.market.chain),symbol:(t.market&&t.market.symbol)||t.symbol||"",muted:true})).then(function(result){
        if(!result||!result.ok)throw Error("屏蔽失败");
        state.mutedTokens=Array.isArray(result.mutes)?result.mutes:[];
        state.tokens=state.tokens.filter(function(item){return item.key!==t.key;});
        renderList();renderFooter();
      }).catch(function(error){muteButton.disabled=false;muteButton.classList.add("failed");muteButton.setAttribute("aria-label","重新屏蔽此代币");muteButton.title=(error.message||"屏蔽失败")+"，点击重试";});
    });
    kolRow.appendChild(muteButton);
    meta.appendChild(symRow);
    meta.appendChild(kolRow);
    left.appendChild(meta);

    var right = $("div", "cell-right");
    var mcEl = $("div", "mc"), mcText = document.createTextNode("");
    var stale = $("span", "mc-stale-tag", "未刷新"); stale.hidden = true;
    mcEl.appendChild(mcText); mcEl.appendChild(stale); right.appendChild(mcEl);
    var chgEl = $("div", "chg");
    var correctButton = $("button", "token-correct-ca");
    correctButton.type = "button";
    correctButton.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/></svg>';
    correctButton.setAttribute("aria-label", "修正 CA");
    correctButton.title = "修正 CA · 首喊时间：" + exactTimeTitle(callBaseline.time != null ? callBaseline.time : firstSeen);
    correctButton.addEventListener("click", function (event) {
      event.preventDefault(); event.stopPropagation(); openCaCorrection(row._token);
    });
    kolRow.appendChild(correctButton);
    right.appendChild(chgEl);
    row.appendChild(left);
    row.appendChild(right);
    row._quoteNodes = {right:right, mc:mcEl, mcText:mcText, stale:stale, change:chgEl, correct:correctButton};
    updateRowQuote(row, t);
    return row;
  }


  function setRowText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function updateRowQuote(row, t) {
    row._token = t;
    var nodes = row._quoteNodes, mcEl = nodes.mc, chgEl = nodes.change, right = nodes.right;
    var callBaseline = pickCallBaseline(t), firstSeen = pickFirstSeen(t), mc = pickMc(t);
    var currentMarket = pickMarket(t);
    var sourceQuoteAt = currentMarket && currentMarket.quoteAt;
    // Request receipt proves refresh activity; provider quote time is a separate fact.
    var currentQuoteAt = currentMarket && (currentMarket.fieldSources && currentMarket.fieldSources.mc && currentMarket.fieldSources.mc.at || currentMarket.receivedAt || currentMarket.updatedAt);
    var currentMcSource = currentMarket && (currentMarket.mcSource || currentMarket.source || currentMarket.provider);
    var currentBasis = currentMarket && currentMarket.mcBasis;
    var currentQuoteAge = currentQuoteAt != null && Number.isFinite(Number(currentQuoteAt))
      ? Math.max(0, state.now - Number(currentQuoteAt))
      : null;
    var currentQuoteStale = currentQuoteAge != null && currentQuoteAge > 30;
    var currentMcEstimated = currentBasis === "supply-derived";

    var mcClass = "mc" + (currentMcEstimated ? " estimated" : "") + (currentQuoteStale ? " stale" : "");
    if (mcEl.className !== mcClass) mcEl.className = mcClass;
    var mcText = fmtCompact(mc);
    if (nodes.mcText.nodeValue !== mcText) nodes.mcText.nodeValue = mcText;
    if (nodes.stale.hidden === currentQuoteStale) nodes.stale.hidden = !currentQuoteStale;
    var quoteTitle = "当前行情来源：" + (currentMcSource || "未知") +
      "；市值口径：" + (currentBasis || "未提供") +
      "；最近接收：" + exactTimeTitle(currentQuoteAt) +
      "；源行情时间：" + (sourceQuoteAt ? exactTimeTitle(sourceQuoteAt) : "未提供") +
      (sourceQuoteAt && state.now - Number(sourceQuoteAt) > 5 * 60 ? "；源行情时间较早，不能据此判断请求停止或没有成交" : "") +
      (currentMcEstimated ? "；市值为报价 × 流通量估算" : "") +
      (currentQuoteStale ? "；超过 30 秒未收到新行情，距今 " + fmtAgoShort(currentQuoteAt, state.now) : "") +
      (currentMarket && currentMarket.endpoint ? "；接口：" + currentMarket.endpoint : "") +
      (currentMarket && currentMarket.poolId ? "；池：" + currentMarket.poolId : "") +
      (currentMarket && currentMarket.fdv != null ? "；FDV：" + fmtCompact(Number(currentMarket.fdv)) : "");

    if (right.title !== quoteTitle) right.title = quoteTitle;
    var changeTitle = "", changeClass = "chg";
    var currentMultiple = t.currentMultiple != null ? Number(t.currentMultiple) : null;
    if (currentMultiple != null && Number.isFinite(currentMultiple) && currentMultiple > 0) {
      var returnPercent = (currentMultiple - 1) * 100;
      setRowText(chgEl, (t.changeApprox ? "≈ " : "") + (returnPercent >= 0 ? "↑ " : "↓ ") + Math.abs(returnPercent).toFixed(1) + "%");
      changeClass += currentMultiple >= 1 ? " up" : " down";
    } else {
      setRowText(chgEl, "待补全");
      changeTitle = "首喊以来涨跌幅待补全：" + (t.changePendingReason || (t.chain === "?" ? "地址所属链待核对" : "等待首喊基准或当前行情"));
    }
    if (!changeTitle) changeTitle = t.changeBasis === "price" && t.changeBasePrice > 0
      ? "喊后涨跌幅 =（当前价格 ÷ 首喊价格 − 1）× 100%；基准来源：" + (t.changeBaseSource || "未知") + (t.changeApprox ? "；≈ 为估算参考，仅用于悬浮窗，不改后台峰值统计" : "")
      : callBaseline.marketCap == null
      ? "喊后涨跌幅待补首喊市值"
      : "喊后涨跌幅 =（当前 " + (currentMcSource || "行情") + " 市值 ÷ 首喊市值 − 1）× 100%。首喊市值 " + (callBaseline.approximate ? "≈" : "") + fmtCompact(callBaseline.marketCap);

    if (chgEl.className !== changeClass) chgEl.className = changeClass;
    if (chgEl.title !== changeTitle) chgEl.title = changeTitle;
    var correctionTitle = "修正 CA · 首喊时间：" + exactTimeTitle(callBaseline.time != null ? callBaseline.time : firstSeen);
    if (nodes.correct.title !== correctionTitle) nodes.correct.title = correctionTitle;
  }

  function filteredTokens() {
    var q = state.query.trim().toLowerCase();
    var confirmedTokens = state.tokens.filter(function (t) {
      var chain = pickChain(t);
      var chainKnown = chain !== "?" && chain !== "unknown" && chain !== "pending" && chain !== "null" && chain !== "undefined";
      var recentPendingShout = t.pending === true && latestMentionTime(t) >= state.now - 60;
      return chainKnown || t.pending === true;
    });
    var tokens = !q ? confirmedTokens.slice() : confirmedTokens.filter(function (t) {
      var sym = pickSymbol(t).toLowerCase();
      var name = pickName(t).toLowerCase();
      var addr = pickAddr(t);
      var raws = pickCallers(t);
      var callers = raws.map(function (raw) {
        var lab = callerLabelOf(raw);
        return lab ? raw + " " + lab : raw;
      }).join(" ").toLowerCase();
      return sym.indexOf(q) >= 0 || name.indexOf(q) >= 0 || addr.indexOf(q) >= 0 || callers.indexOf(q) >= 0;
    });
    // Keep shout recency independent from peak ranking so every new CA call
    // surfaces its existing or new card at the top of the monitor.
    if (state.peakMultipleSort === "off") {
      return tokens.map(function (token, index) { return { token: token, index: index, latest: latestMentionTime(token) }; })
        .sort(function (a, b) { return b.latest - a.latest || a.index - b.index; })
        .map(function (item) { return item.token; });
    }
    var newestTime = tokens.reduce(function (latest, token) { return Math.max(latest, latestMentionTime(token)); }, 0);
    var direction = state.peakMultipleSort === "desc" ? -1 : 1;
    return tokens.map(function (token, index) { return { token: token, index: index, latest: latestMentionTime(token) }; }).sort(function (a, b) {
      var aNewest = a.latest === newestTime;
      var bNewest = b.latest === newestTime;
      if (aNewest !== bNewest) return aNewest ? -1 : 1;
      var aPeak = pickPeakMultiple(a.token);
      var bPeak = pickPeakMultiple(b.token);
      if (aPeak == null || bPeak == null) {
        if (aPeak == null && bPeak != null) return 1;
        if (bPeak == null && aPeak != null) return -1;
        return a.index - b.index;
      }
      return (aPeak - bPeak) * direction || a.index - b.index;
    }).map(function (item) { return item.token; });
  }

  function latestMentionTime(token) {
    var mentions = Array.isArray(token.mentions) ? token.mentions : [];
    var latest = Number(token.firstSeen);
    if (!Number.isFinite(latest)) latest = 0;
    for (var i = 0; i < mentions.length; i++) {
      var mention = mentions[i] || {};
      var time = Number(mention.time != null ? mention.time : mention.at != null ? mention.at : mention.ts);
      if (Number.isFinite(time) && time > latest) latest = time;
    }
    return latest;
  }
  function renderPeakMultipleSort() {
    var sort = state.peakMultipleSort;
    var order = sort === "desc" ? " \u2193" : sort === "asc" ? " \u2191" : "";
    var orderText = sort === "desc" ? "\u9ad8\u5230\u4f4e" : sort === "asc" ? "\u4f4e\u5230\u9ad8" : "\u5173\u95ed\uff08\u6309\u6700\u65b0\u558a\u5355\uff09";
    els.sortMultiple.textContent = "峰值排序" + order;
    els.sortMultiple.title = "按已核实峰值排序";
    els.sortMultiple.title = "按喊后最高倍数排序；缺正式峰值时使用实时观察参考值，仅用于悬浮窗（" + orderText + "）";
    els.sortMultiple.setAttribute("aria-label", els.sortMultiple.title);
    els.sortMultiple.setAttribute("aria-pressed", sort === "off" ? "false" : "true");
  }

  function linkLabel() {
    if (state.link === "connected") return T.connected;
    if (state.link === "connecting") return T.connecting;
    if (state.link === "reconnecting") return T.reconnecting;
    if (state.link === "failed" || state.link === "error") {
      return state.message ? T.failed + ": " + state.message : T.failed;
    }
    return T.disconnected;
  }

  function linkDotClass() {
    if (state.link === "connected") return "ok";
    if (state.link === "connecting" || state.link === "reconnecting") return "amber";
    return "err";
  }


  function closeLabelModal() {
    state.labelEditRaw = null;
    if (els.labelModal) els.labelModal.hidden = true;
  }

  function openLabelModal(raw) {
    if (!els.labelModal || raw == null || raw === "") return;
    state.labelEditRaw = String(raw);
    if (els.labelModalError) { els.labelModalError.hidden = true; els.labelModalError.textContent = ""; }
    if (els.labelRawV) els.labelRawV.textContent = state.labelEditRaw;
    if (els.labelInput) {
      els.labelInput.value = callerLabelOf(state.labelEditRaw);
      els.labelInput.focus();
      try { els.labelInput.select(); } catch (e) { /* ignore */ }
    }
    els.labelModal.hidden = false;
  }

  function saveLabelFromModal() {
    var raw = state.labelEditRaw;
    if (raw == null) return closeLabelModal();
    var label = els.labelInput ? String(els.labelInput.value || "").trim() : "";
    applyCallerLabel(raw, label || null);
  }

  function clearLabelFromModal() {
    var raw = state.labelEditRaw;
    if (raw == null) return closeLabelModal();
    if (els.labelInput) els.labelInput.value = "";
    applyCallerLabel(raw, null);
  }

  function applyCallerLabel(raw, label) {
    if (window.fomomo && window.fomomo.setCallerLabel) {
      Promise.resolve(window.fomomo.setCallerLabel(raw, label)).then(function (map) {
        if (!map || map.ok !== true || !map.labels || typeof map.labels !== "object") throw new Error(map && map.error || "保存喊单人标签失败");
        state.callerLabels = map.labels;
        closeLabelModal();
        renderList();
      }).catch(function (error) {
        if (els.labelModalError) {
          els.labelModalError.textContent = error && error.message ? error.message : String(error);
          els.labelModalError.hidden = false;
        }
      });
      return;
    }
    if (!state.callerLabels) state.callerLabels = {};
    if (label == null || String(label).trim() === "") delete state.callerLabels[raw];
    else state.callerLabels[raw] = String(label).trim();
    closeLabelModal();
    renderList();
  }

  var VIRTUAL_ROW_HEIGHT = 70;
  var VIRTUAL_OVERSCAN = 6;
  var lastViewportKey = null;
  var rowNodes = new Map();
  var topVirtualSpacer, bottomVirtualSpacer;
  function rowIdentity(token) {
    var callers = pickCallers(token);
    return JSON.stringify([pickAddr(token),pickChain(token),pickResolved(token),pickSymbol(token),pickLogo(token),
      token.logoLookup && token.logoLookup.failedUrls,token.pending,token.verified,token.fresh,
      callers.map(function(raw){return [raw,callerLabelOf(raw)];}),pickChannelSources(token),pickKol(token),
      state.freshID && pickTokenKey(token) === String(state.freshID),
      state.selectedToken && state.selectedToken.key === pickTokenKey(token)]);
  }
  function reconcileListChildren(parent, nodes) {
    for (var i=0;i<nodes.length;i++) {
      if (parent.childNodes[i] !== nodes[i]) parent.insertBefore(nodes[i],parent.childNodes[i] || null);
    }
    while (parent.childNodes.length > nodes.length) parent.removeChild(parent.lastChild);
  }
  function reportVisibleTokens() {
    if (!window.fomomo || !window.fomomo.setVisibleTokens) return;
    var first = Math.max(0, Math.floor(els.list.scrollTop / VIRTUAL_ROW_HEIGHT));
    var count = Math.min(50, Math.ceil((els.list.scrollTop % VIRTUAL_ROW_HEIGHT + els.list.clientHeight) / VIRTUAL_ROW_HEIGHT));
    var tokens = document.hidden || document.body.classList.contains("overlay-collapsed") ? [] : state.visibleTokens.slice(first, first + count)
      .map(function (t) { return { address: t.address, chain: t.market && t.market.chain || t.chainHint || null }; });
    var key = JSON.stringify(tokens);
    if (lastViewportKey !== key) {
      lastViewportKey = key;
      Promise.resolve(window.fomomo.setVisibleTokens(tokens)).catch(function () {
        if (lastViewportKey === key) lastViewportKey = null;
      });
    }
  }
  document.addEventListener("visibilitychange", function () { lastViewportKey = null; reportVisibleTokens(); });

  function openCaCorrection(token) {
    if (document.getElementById("ca-correction-dialog")) return;
    var dialog = $("dialog", "ca-correction-dialog");
    dialog.id = "ca-correction-dialog";
    var form = $("form", "ca-correction-form");
    var heading = $("h3", "", "修正 CA"); heading.id = "ca-correction-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    form.appendChild(heading);
    form.appendChild($("p", "", "原地址：" + token.address));
    form.appendChild($("p", "", "保留原喊单人和时间。该地址已有的喊单及后续消息都会使用新 CA。"));
    var label = $("label", "", "正确 CA");
    var input = $("input", ""); input.type = "text"; input.required = true;
    input.id = "corrected-ca"; input.autocomplete = "off"; input.spellcheck = false;
    label.htmlFor = input.id; form.appendChild(label); form.appendChild(input);
    var error = $("p", "ca-correction-error"); error.setAttribute("role", "alert"); form.appendChild(error);
    var actions = $("div", "ca-correction-actions");
    var cancel = $("button", "", "取消"); cancel.type = "button";
    cancel.onclick = function () { dialog.close(); };
    var submit = $("button", "", "保存修正"); submit.type = "submit";
    actions.appendChild(cancel); actions.appendChild(submit); form.appendChild(actions);
    form.onsubmit = function (event) {
      event.preventDefault(); submit.disabled = true; error.textContent = "";
      Promise.resolve(window.fomomo.correctCa({chain:pickChain(token),address:token.address,correctedAddress:input.value.trim()})).then(function () {
        dialog.close();
      }).catch(function (failure) { error.textContent = failure.message || "修正失败"; submit.disabled = false; });
    };
    dialog.addEventListener("close", function () { dialog.remove(); });
    dialog.appendChild(form); document.body.appendChild(dialog); dialog.showModal(); input.focus();
  }

  var seenLatencyTraceIds = Object.create(null);
  var pendingLatencyTraceIds = Object.create(null);
  var latencyTraceSeeded = false;
  var pendingReceivedTraces = Object.create(null);
  var receiptBusy = false;
  function reportReceivedLatencyTraces() {
    if (receiptBusy || !window.fomomo || !window.fomomo.reportReceivedCalls) return;
    var entries = Object.keys(pendingReceivedTraces).slice(0, 500).map(function (id) { return { traceId: id, receivedAtMs: pendingReceivedTraces[id] }; });
    if (!entries.length) return;
    receiptBusy = true;
    window.fomomo.reportReceivedCalls(entries).then(function () {
      entries.forEach(function (entry) { delete pendingReceivedTraces[entry.traceId]; });
    }).catch(function () {}).finally(function () {
      receiptBusy = false;
      if (Object.keys(pendingReceivedTraces).length) setTimeout(reportReceivedLatencyTraces, 1000);
    });
  }
  var latencyReportFramePending = false;
  function rememberLatencyTraces(tokens) {
    var initialize = !latencyTraceSeeded;
    var recentCutoffMs = Date.now() - 10 * 60 * 1000;
    tokens.forEach(function (token) {
      (Array.isArray(token.mentions) ? token.mentions : []).forEach(function (mention) {
        var traceId = mention && mention.traceId;
        if (typeof traceId !== "string" || seenLatencyTraceIds[traceId]) return;
        seenLatencyTraceIds[traceId] = true;
        if (!initialize || Number(mention.ts) * 1000 >= recentCutoffMs) {
          pendingLatencyTraceIds[traceId] = true;
          pendingReceivedTraces[traceId] = Date.now();
        }
      });
    });
    latencyTraceSeeded = true;
    reportReceivedLatencyTraces();
  }
  function reportVisibleLatencyTraces() {
    if (latencyReportFramePending || document.hidden || document.body.classList.contains("overlay-collapsed") || !window.fomomo || typeof window.fomomo.reportRenderedCalls !== "function") return;
    latencyReportFramePending = true;
    requestAnimationFrame(function () {
      latencyReportFramePending = false;
      if (document.hidden || document.body.classList.contains("overlay-collapsed")) return;
      var first = Math.max(0, Math.floor(els.list.scrollTop / VIRTUAL_ROW_HEIGHT));
      var count = Math.min(50, Math.ceil((els.list.scrollTop % VIRTUAL_ROW_HEIGHT + els.list.clientHeight) / VIRTUAL_ROW_HEIGHT));
      var traces = Object.keys(pendingLatencyTraceIds).filter(function (traceId) {
        return state.visibleTokens.slice(first, first + count).some(function (token) {
          return Array.isArray(token.mentions) && token.mentions.some(function (mention) { return mention.traceId === traceId; });
        });
      }).slice(0, 500);
      if (!traces.length) return;
      var displayedAtMs = Date.now();
      window.fomomo.reportRenderedCalls(traces, displayedAtMs).then(function () {
        traces.forEach(function (traceId) { delete pendingLatencyTraceIds[traceId]; });
      }).catch(function () { setTimeout(reportVisibleLatencyTraces, 1000); });
    });
  }

  function renderVisibleRows(force) {
    reportVisibleTokens();
    var shown = state.visibleTokens;
    var total = shown.length;
    var maxScroll = Math.max(0, total * VIRTUAL_ROW_HEIGHT - els.list.clientHeight);
    var scrollTop = Math.min(els.list.scrollTop, maxScroll);
    var start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    var count = Math.ceil((els.list.scrollTop % VIRTUAL_ROW_HEIGHT + els.list.clientHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2;
    var end = Math.min(total, start + count);
    if (!force && start === state.virtualStart && end === state.virtualEnd) {
      // The viewport can reveal an overscan row without changing the mounted range.
      reportVisibleLatencyTraces();
      return;
    }

    var nodes = [];
    if (start > 0) {
      if (!topVirtualSpacer) { topVirtualSpacer = $("div", "list-spacer"); topVirtualSpacer.setAttribute("aria-hidden", "true"); }
      var topHeight = start * VIRTUAL_ROW_HEIGHT + "px";
      if (topVirtualSpacer.style.height !== topHeight) topVirtualSpacer.style.height = topHeight;
      nodes.push(topVirtualSpacer);
    }
    var retained = new Set();
    for (var i = start; i < end; i++) {
      var token=shown[i],key=pickTokenKey(token),existing=rowNodes.get(key);
      var selectedKey=state.selectedToken && state.selectedToken.key;
      var changed=!existing || existing.token!==token || existing.labels!==state.callerLabels || existing.freshID!==state.freshID || existing.selectedKey!==selectedKey;
      var identity=changed?rowIdentity(token):existing.identity;
      var fresh;
      if(existing && existing.identity===identity){
        fresh=existing.node;
        if(changed)updateRowQuote(fresh,token);
      }else fresh=buildRow(token);
      rowNodes.set(key,{node:fresh,identity:identity,token:token,labels:state.callerLabels,freshID:state.freshID,selectedKey:selectedKey});
      retained.add(key);nodes.push(fresh);
    }
    rowNodes.forEach(function(_row,key){if(!retained.has(key))rowNodes.delete(key);});
    if (end < total) {
      if (!bottomVirtualSpacer) { bottomVirtualSpacer = $("div", "list-spacer"); bottomVirtualSpacer.setAttribute("aria-hidden", "true"); }
      var bottomHeight = (total - end) * VIRTUAL_ROW_HEIGHT + "px";
      if (bottomVirtualSpacer.style.height !== bottomHeight) bottomVirtualSpacer.style.height = bottomHeight;
      nodes.push(bottomVirtualSpacer);
    }
    reconcileListChildren(els.list,nodes);
    if (els.list.scrollTop !== scrollTop) els.list.scrollTop = scrollTop;
    state.virtualStart = start;
    state.virtualEnd = end;
    reportVisibleLatencyTraces();
  }

  function renderList() {
    state.now = Date.now() / 1000;
    var activeSortKeys = new Set(state.tokens.map(pickTokenKey));
    observedSortPeaks.forEach(function (_value, key) { if (!activeSortKeys.has(key)) observedSortPeaks.delete(key); });
    renderPeakMultipleSort();
    state.visibleTokens = filteredTokens();
    state.virtualStart = -1;
    state.virtualEnd = -1;
    renderVisibleRows(true);
    var shown = state.visibleTokens;
    var empty = shown.length === 0;
    els.empty.classList.toggle("show", empty);
    if (empty) {
      els.empty.classList.remove("cta");
      els.empty.onclick = null;
      if (state.tokens.length === 0) {
        if (state.link === "connected" && state.sourcesConfigured === false) {
          els.empty.textContent = T.emptyNoSources;
          els.empty.classList.add("cta");
          els.empty.onclick = function () {
            if (window.fomomo && window.fomomo.openDashboard) window.fomomo.openDashboard("groups");
          };
        } else {
          els.empty.textContent = state.link === "connected" ? T.emptyWait : linkLabel();
        }
      } else {
        var q = state.query.trim();
        els.empty.textContent = T.emptyNoMatchPre + q + T.emptyNoMatchPost;
      }
    }
    if (state.query.trim()) {
      els.searchCount.hidden = false;
      els.searchCount.textContent = shown.length + "/" + state.tokens.length;
      els.searchClear.hidden = false;
    } else {
      els.searchCount.hidden = true;
      els.searchClear.hidden = true;
    }
  }

  els.list.addEventListener("scroll", function () { renderVisibleRows(false); }, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    var listResizeObserver = new ResizeObserver(function () {
      state.virtualStart = -1;
      state.virtualEnd = -1;
      renderVisibleRows(true);
    });
    listResizeObserver.observe(els.list);
  }

  var lastHeaderPresentation, lastFooterPresentation;
  function renderHeader() {
    var nTokens = state.tokens.filter(function (t) { return t.verified === true; }).length;
    var presentation=JSON.stringify([nTokens,state.tokens.length,state.link,state.message,Math.floor(Date.now()/60000)]);
    if(presentation===lastHeaderPresentation)return;
    lastHeaderPresentation=presentation;
    els.subtitle.title = "已确认代币 " + nTokens + "；待核对地址 " + (state.tokens.length - nTokens);
    els.subtitle.replaceChildren();
    els.subtitle.appendChild($("span", "n", String(nTokens)));
    els.subtitle.appendChild(document.createTextNode(" 个代币"));

    var ok = state.link === "connected";
    els.subDot.className = "dot " + (ok ? "ok" : "amber");
    els.liveLabel.textContent = ok ? "实时监控" : linkLabel();
    var clock = new Date();
    els.clock.textContent = String(clock.getMonth() + 1).padStart(2, "0") + "/" + String(clock.getDate()).padStart(2, "0") + " " + String(clock.getHours()).padStart(2, "0") + ":" + String(clock.getMinutes()).padStart(2, "0");
    els.eq.hidden = !ok;
    els.eq.setAttribute("aria-hidden", ok ? "false" : "true");
  }

  function renderFooter() {
    var presentation=JSON.stringify([state.link,state.message,state.mutedTokens.length,state.dashboardUrl]);
    if(presentation===lastFooterPresentation)return;
    lastFooterPresentation=presentation;
    els.ftDot.className = "dot " + linkDotClass();
    els.ftLink.textContent = linkLabel();
    els.mutedLabel.textContent = "屏蔽 " + state.mutedTokens.length;
    els.btnMuted.title = "已屏蔽问题代币（" + state.mutedTokens.length + "）· 恢复后重新显示代币";
    els.btnMuted.setAttribute("aria-label", els.btnMuted.title);
    /* The Windows desktop always exposes its local dashboard. */
    var showDash = state.dashboardUrl !== false && state.dashboardUrl != null;
    els.btnSettings.hidden = !showDash;
  }

  function refreshMutedTokens() {
    if (!window.fomomo || typeof window.fomomo.getMonitorMutes !== "function") return Promise.resolve(state.mutedTokens);
    return Promise.resolve(window.fomomo.getMonitorMutes()).then(function (result) {
      if (!result || !result.ok) throw new Error(result && result.error || "读取屏蔽列表失败");
      state.mutedTokens = Array.isArray(result.mutes) ? result.mutes : [];
      renderFooter();
      return state.mutedTokens;
    });
  }

  function renderMutedMenu() {
    els.mutedList.replaceChildren();
    var items = Array.isArray(state.mutedTokens) ? state.mutedTokens : [];
    if (!items.length) {
      els.mutedList.appendChild($("div", "muted-empty", "没有已屏蔽代币"));
      return;
    }
    items.forEach(function (entry) {
      var row = $("div", "muted-row");
      var info = $("div", "muted-info");
      var title = $("div", "muted-name", String(entry.symbol || shortAddr(entry.address)));
      var chain = chainMeta(entry.chain || "?");
      var sub = $("div", "muted-sub");
      sub.appendChild($("span", "chain " + chain.cls, chain.label));
      sub.appendChild($("span", "muted-address", shortAddr(entry.address)));
      info.appendChild(title);
      info.appendChild(sub);
      var restore = $("button", "muted-restore", "恢复");
      restore.type = "button";
      restore.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        restore.disabled = true;
        els.mutedStatus.textContent = "正在恢复…";
        Promise.resolve(window.fomomo.setMonitorMuted({
          address: entry.address,
          chain: entry.chain,
          symbol: entry.symbol || "",
          muted: false,
        })).then(function (result) {
          if (!result || !result.ok) throw new Error(result && result.error || "恢复失败");
          state.mutedTokens = Array.isArray(result.mutes) ? result.mutes : [];
          els.mutedStatus.textContent = "已恢复显示；数据库记录始终保留。";
          renderMutedMenu();
          renderFooter();
        }).catch(function (error) {
          restore.disabled = false;
          els.mutedStatus.textContent = error && error.message ? error.message : String(error);
        });
      });
      row.appendChild(info);
      row.appendChild(restore);
      els.mutedList.appendChild(row);
    });
  }

  function renderAll() {
    renderHeader();
    renderList();
    renderFooter();
  }

  if (els.labelBackdrop) els.labelBackdrop.addEventListener("click", closeLabelModal);
  if (els.labelCancel) els.labelCancel.addEventListener("click", closeLabelModal);
  if (els.labelSave) els.labelSave.addEventListener("click", saveLabelFromModal);
  if (els.labelClear) els.labelClear.addEventListener("click", clearLabelFromModal);
  if (els.labelInput) {
    els.labelInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        saveLabelFromModal();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeLabelModal();
      }
    });
  }

  els.search.addEventListener("input", function () {
    state.query = els.search.value || "";
    renderCaQueryControls();
    renderList();
  });
  els.search.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && isCaAddress(els.search.value)) {
      e.preventDefault();
      runAveQuery();
      return;
    }
    if (e.key === "Escape") {
      els.search.value = "";
      state.query = "";
      renderCaQueryControls();
      renderList();
    }
  });
  els.searchClear.addEventListener("click", function () {
    els.search.value = "";
    state.query = "";
    renderCaQueryControls();
    renderList();
    els.search.focus();
  });
  function isCaAddress(value) {
    var address = String(value || "").trim();
    return /^0x[0-9a-f]{40}$/i.test(address) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  function renderCaQueryControls() {
    var valid = isCaAddress(els.search.value);
    els.caQuery.hidden = !valid;
    if (!valid) {
      els.caQueryResult.hidden = true;
      els.caQueryPair.hidden = true;
    } else {
      els.caQueryStatus.textContent = "已匹配 CA；选择链后查询 AVE。";
    }
  }
  function queryMoney(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? "$" + new Intl.NumberFormat("en-US", { maximumSignificantDigits: 7 }).format(value)
      : "未提供";
  }
  var queryChains = { sol: "Solana", bsc: "BSC", eth: "Ethereum", base: "Base", arbitrum: "Arbitrum", optimism: "Optimism", polygon: "Polygon", robinhood: "Robinhood", xlayer: "X Layer", avalanche: "Avalanche", monad: "Monad", giwa: "Giwa" };
  function showAveQueryResult(data) {
    els.caQueryResult.hidden = false;
    els.caQueryTitle.textContent = [data.symbol, data.name, queryChains[data.chain] || data.chain].filter(Boolean).join(" · ");
    els.caQueryPrice.textContent = queryMoney(data.priceUsd);
    els.caQueryMc.textContent = queryMoney(data.marketCapUsd);
    els.caQueryLiquidity.textContent = queryMoney(data.liquidityUsd);
    els.caQueryHolders.textContent = Number.isFinite(data.holders) ? new Intl.NumberFormat("en-US").format(data.holders) : "未提供";
    var quoteAt = data.quoteAt ? new Date(data.quoteAt).toLocaleString() : "AVE 未提供源报价时间";
    var receivedAt = data.receivedAt ? new Date(data.receivedAt).toLocaleString() : "未知";
    els.caQueryTime.textContent = "源报价时间：" + quoteAt + " · 本机接收：" + receivedAt;
    els.caQueryWarning.hidden = !data.warning;
    els.caQueryWarning.textContent = data.warning || "";
  }
  async function runAveQuery() {
    var chain = els.caQueryChain.value;
    var address = els.search.value.trim();
    if (!chain) {
      els.caQueryStatus.textContent = "请先手动选择链；不会自动猜测 EVM 链。";
      els.caQueryChain.focus();
      return;
    }
    if (!window.fomomo || typeof window.fomomo.queryAveDetails !== "function") {
      els.caQueryStatus.textContent = "当前桌面版本不支持 AVE 查询，请更新本地应用。";
      return;
    }
    els.caQueryRun.disabled = true;
    els.caQueryPair.hidden = true;
    els.caQueryResult.hidden = true;
    els.caQueryStatus.textContent = "正在通过 AVE 查询…";
    try {
      var result = await window.fomomo.queryAveDetails(chain, address);
      showAveQueryResult(result);
      els.caQueryStatus.textContent = "查询完成；结果来自 AVE。";
    } catch (error) {
      var message = error instanceof Error ? error.message : String(error);
      els.caQueryStatus.textContent = message;
      els.caQueryPair.hidden = !/脚本未连接|脚本猫|桥接|浏览器/.test(message);
    } finally {
      els.caQueryRun.disabled = false;
    }
  }
  els.caQueryRun.addEventListener("click", runAveQuery);
  els.caQueryPair.addEventListener("click", function () {
    if (window.fomomo && window.fomomo.openDashboard) window.fomomo.openDashboard("settings");
  });
  els.sortMultiple.addEventListener("click", function () {
    state.peakMultipleSort = state.peakMultipleSort === "off" ? "desc" : state.peakMultipleSort === "desc" ? "asc" : "off";
    try { localStorage.setItem("fomomo.peakMultipleSort.v3", state.peakMultipleSort); } catch (e) { /* keep this session's choice */ }
    els.list.scrollTop = 0;
    renderList();
  });
  els.btnHide.addEventListener("click", function () {
    if (window.fomomo && window.fomomo.collapse) window.fomomo.collapse();
  });
  var collapsedPointer = null;
  els.collapsedLogo.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return;
    event.preventDefault();
    collapsedPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    els.collapsedLogo.setPointerCapture(event.pointerId);
    if (window.fomomo && window.fomomo.beginCollapsedDrag) window.fomomo.beginCollapsedDrag();
  });
  els.collapsedLogo.addEventListener("pointermove", function (event) {
    if (!collapsedPointer || event.pointerId !== collapsedPointer.id) return;
    var dx = event.clientX - collapsedPointer.x;
    var dy = event.clientY - collapsedPointer.y;
    if (!collapsedPointer.moved && dx * dx + dy * dy < 16) return;
    collapsedPointer.moved = true;
    if (window.fomomo && window.fomomo.moveCollapsed) window.fomomo.moveCollapsed();
  });
  function finishCollapsedPointer(event) {
    if (!collapsedPointer || event.pointerId !== collapsedPointer.id) return;
    var shouldExpand = !collapsedPointer.moved;
    collapsedPointer = null;
    if (els.collapsedLogo.hasPointerCapture(event.pointerId)) els.collapsedLogo.releasePointerCapture(event.pointerId);
    if (window.fomomo && window.fomomo.endCollapsedDrag) window.fomomo.endCollapsedDrag();
    if (shouldExpand && window.fomomo && window.fomomo.expand) window.fomomo.expand();
  }
  els.collapsedLogo.addEventListener("pointerup", finishCollapsedPointer);
  els.collapsedLogo.addEventListener("pointercancel", finishCollapsedPointer);
  els.btnMuted.addEventListener("click", function () {
    var opening = els.mutedMenu.hidden;
    if (!opening) {
      els.mutedMenu.hidden = true;
      return;
    }
    els.mutedStatus.textContent = "仅隐藏悬浮窗显示，不影响数据库统计。";
    els.mutedMenu.hidden = false;
    renderMutedMenu();
    refreshMutedTokens().then(renderMutedMenu).catch(function (error) {
      els.mutedStatus.textContent = error && error.message ? error.message : String(error);
    });
  });
  document.addEventListener("pointerdown", function (event) {
    if (!els.mutedMenu.hidden && !els.mutedMenu.contains(event.target) && !els.btnMuted.contains(event.target)) els.mutedMenu.hidden = true;
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !els.mutedMenu.hidden) {
      els.mutedMenu.hidden = true;
      els.btnMuted.focus();
    }
  });
  els.btnSettings.addEventListener("click", function () {
    if (window.fomomo && window.fomomo.openDashboard) window.fomomo.openDashboard(null);
  });
  function normalizeTokens(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.tokens)) return payload.tokens;
    return [];
  }

  function keepRecentTokens(tokens) {
    var cutoff = Date.now() / 1000 - 24 * 3600;
    return tokens.filter(function (token) {
      return Array.isArray(token && token.mentions) && token.mentions.some(function (mention) {
        var time = Number(mention && (mention.time != null ? mention.time : mention.at != null ? mention.at : mention.ts));
        return Number.isFinite(time) && time >= cutoff;
      });
    });
  }

  if (window.fomomo && window.fomomo.onState) {
    window.fomomo.onState(function (tokens) {
      var nextTokens = keepRecentTokens(normalizeTokens(tokens));
      rememberLatencyTraces(nextTokens);
      state.tokens = nextTokens;
      if (state.selectedToken) {
        var matches = state.tokens.filter(function (t) { return pickAddr(t) === state.selectedToken.address; });
        var exact = matches.some(function (t) { return pickTokenKey(t) === state.selectedToken.key; });
        if (!exact && matches.length === 1) {
          var resolved = matches[0];
          state.selectedToken.key = pickTokenKey(resolved);
          state.selectedToken.chain = pickChain(resolved);
          state.selectedToken.symbol = pickSymbol(resolved) || shortAddr(state.selectedToken.address);
          if (window.fomomo.focusToken) window.fomomo.focusToken(state.selectedToken.chain === "?" ? null : state.selectedToken.chain, state.selectedToken.address);
        }
      }
      renderAll();
    });
  }

  if (window.fomomo && window.fomomo.onOverlayMode) {
    window.fomomo.onOverlayMode(function (collapsed) {
      document.body.classList.toggle("overlay-collapsed", collapsed);
      lastViewportKey = null;
      reportVisibleTokens();
      els.collapsedLogo.hidden = !collapsed;
    });
  }
  if (window.fomomo && window.fomomo.onStatus) {
    window.fomomo.onStatus(function (s) {
      if (!s) return;
      if (s.link) state.link = s.link;
      if (Array.isArray(s.groups)) state.groups = s.groups;
      if (typeof s.message === "string") state.message = s.message;
      if ("freshID" in s) state.freshID = s.freshID || null;
      if ("sourcesConfigured" in s) {
        state.sourcesConfigured = s.sourcesConfigured == null ? null : !!s.sourcesConfigured;
      }
      if ("dashboardUrl" in s) state.dashboardUrl = s.dashboardUrl;
      renderAll();
    });
  }

  if (window.fomomo && window.fomomo.onCallerLabels) {
    window.fomomo.onCallerLabels(function (map) {
      state.callerLabels = map && typeof map === "object" ? map : {};
      renderList();
    });
  }
  if (window.fomomo && window.fomomo.getCallerLabels) {
    Promise.resolve(window.fomomo.getCallerLabels()).then(function (map) {
      state.callerLabels = map && typeof map === "object" ? map : {};
      renderList();
    }).catch(function () { /* ignore */ });
  }
  if (window.fomomo && window.fomomo.getMonitorMutes) {
    refreshMutedTokens().catch(function () { /* local sidecar may still be starting */ });
  }

  setInterval(function () {
    if (!document.hidden && !document.body.classList.contains("overlay-collapsed") && state.tokens.length) {
      var recent = keepRecentTokens(state.tokens);
      if (recent.length !== state.tokens.length) {
        state.tokens = recent;
        renderList();
        renderHeader();
      } else {
        state.now = Date.now() / 1000;
        rowNodes.forEach(function(entry){updateRowQuote(entry.node,entry.token);});
        renderHeader();
      }
    }
  }, 5000);

  renderAll();
})();



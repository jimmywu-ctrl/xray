const $ = (s) => document.querySelector(s);
let state,
  page = "overview",
  query = "",
  source = "";
const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  overview: "总览",
  live: "实时监控",
  repair: "数据补齐",
  settings: "设置",
};
const statuses = {
  pending_token: "待确认代币",
  missing_baseline: "待补首喊基准",
  missing_peak: "待补喊后高点",
  ready_exact: "正式统计",
  ready_approx: "估算参考",
};
const money = (v) =>
  v == null
    ? "—"
    : v >= 1e9
      ? "$" + (v / 1e9).toFixed(2) + "B"
      : v >= 1e6
        ? "$" + (v / 1e6).toFixed(2) + "M"
        : v >= 1e3
          ? "$" + (v / 1e3).toFixed(1) + "K"
          : "$" + v.toFixed(2);
const multiple = (v) => (v == null ? "—" : v.toFixed(2) + "×");
async function api(url, body) {
  const r = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? "请求失败");
  return data;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 4500);
}
const title = (name, description, actions = "") =>
  `<div class="page-top"><div><h1>${name}</h1><p class="subtle">${description}</p></div><div class="actions">${actions}</div></div>`;
const image = (r) =>
  r.logo
    ? `<img src="${escape(r.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : "";
const rows = () =>
  state.rows.filter(
    (r) =>
      (!source || r.source === source) &&
      (!query ||
        (r.symbol ?? "").toLowerCase().includes(query.toLowerCase()) ||
        r.address.toLowerCase().includes(query.toLowerCase())),
  );
const empty = () =>
  `<div class="empty"><h2>从下一次喊单开始</h2><p>连接微信或 Telegram，选择需要监听的群。<br>发现新代币后，会自动补资料并追踪行情。</p><button class="primary" data-page="settings">配置监控</button></div>`;
function statsTable(data) {
  return `<div class="table-wrap"><table><thead><tr><th>代币 / 链</th><th>首喊人</th><th class="num">首喊市值</th><th class="num">喊后峰值倍数</th><th>状态</th></tr></thead><tbody>${data.map((r) => `<tr><td><div class="token-cell">${image(r)}<div><span class="token-name">${escape(r.symbol ?? "待识别")}</span><span class="token-meta">${escape(r.chain.toUpperCase())} · ${escape(r.address.slice(0, 8))}…${escape(r.address.slice(-6))}<button class="compact-copy" data-copy="${escape(r.address)}">复制</button></span></div></div></td><td>${escape(r.sender)}<span class="token-meta">${new Date(r.at * 1000).toLocaleString("zh-CN", { hour12: false })}</span></td><td class="num">${money(r.baseline?.mc)}</td><td class="num"><span class="highlight up">${multiple(r.formalMultiple)}</span>${r.referenceMultiple != null ? `<span class="token-meta">估算参考 ${multiple(r.referenceMultiple)}</span>` : ""}${r.maxObservedLossPct != null ? `<span class="token-meta">已观测跌幅 ${Math.abs(r.maxObservedLossPct).toFixed(1)}%</span>` : ""}</td><td><span class="badge ${r.status === "ready_exact" ? "" : r.status === "ready_approx" ? "neutral" : "pending"}">${statuses[r.status] ?? r.status}</span><details class="details"><summary>数据来源</summary><p>基准：${escape(r.baseline?.provider ?? "尚未取得")}<br>正式峰值：${escape(r.formalPeak?.provider ?? "尚未取得")}<br>参考峰值：${escape(r.referencePeak?.provider ?? "无")}<br>名称来源：${escape(r.sources?.symbol?.provider ?? "尚未取得")}</p></details></td></tr>`).join("")}</tbody></table></div>`;
}
function render() {
  if (!state) return;
  $("#breadcrumb").textContent = "X-ray / " + labels[page];
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("selected", b.dataset.page === page));
  let html = state.demo
    ? '<div class="demo-banner">界面演示 · 合成测试数据，不是正式数据库</div>'
    : "";
  if (page === "overview") {
    const o = state.overview;
    html +=
      title(
        "监控总览",
        "首次真人喊单，持续记录喊后新高。",
        "<button data-overlay>打开悬浮窗</button>",
      ) +
      `<div class="metrics">${[
        ["首喊记录", o.total],
        ["正式可计算", o.formal],
        ["待补数据", o.pending],
        [
          "达到 2×",
          o.formal ? Math.round((o.wins / o.formal) * 100) + "%" : "—",
        ],
      ]
        .map(
          ([label, value]) =>
            `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`,
        )
        .join("")}</div>`;
    if (!state.rows.length)
      html += `<section class="panel">${empty()}</section>`;
    else
      html += `<section class="panel"><h2>喊单人排行</h2><div class="table-wrap"><table><thead><tr><th>排名</th><th>喊单人</th><th class="num">平均峰值倍数</th><th class="num">有效样本</th><th class="num">2× 命中率</th><th>代表代币</th></tr></thead><tbody>${state.leaderboard.map((r, i) => `<tr><td>${String(i + 1).padStart(2, "0")}</td><td><b>${escape(r.name)}</b></td><td class="num highlight up">${multiple(r.average)}</td><td class="num">${r.valid} / ${r.total}</td><td class="num">${r.winRate == null ? "—" : (r.winRate * 100).toFixed(1) + "%"}</td><td>${escape(r.best?.symbol ?? "—")}</td></tr>`).join("")}</tbody></table></div><p class="note">排行计入所有已算出正式倍数的喊单；样本数会显示在表格中。</p></section><section class="panel"><h2>最近首喊</h2>${statsTable(state.rows.slice(0, 15))}</section>`;
  } else if (page === "live") {
    html +=
      title(
        "实时监控",
        "悬浮窗当前可见币优先使用 AVE 行情，DEX 补缺并兜底；屏外活跃币由 DEX 主查；后台资料按 AVE→DEX 逐级补查，喊单前价格使用 AVE。AVE 登录状态保存在本机。",
        '<button data-overlay class="primary">打开悬浮窗</button>',
      ) +
      `<div class="toolbar"><input class="search" placeholder="搜索代币名称 / CA" value="${escape(query)}"><select id="source-filter"><option value="">全部来源</option><option value="wechat" ${source === "wechat" ? "selected" : ""}>微信</option><option value="telegram" ${source === "telegram" ? "selected" : ""}>Telegram</option></select></div><div class="live-grid">${rows()
        .map(
          (r) =>
            `<article class="live-card">${image(r)}<div class="info"><b>${escape(r.symbol ?? "待识别")}</b><span class="token-meta">${escape(r.chain.toUpperCase())} · ${escape(r.sender)}</span><span class="token-meta">${escape(r.address.slice(0, 8))}…${escape(r.address.slice(-6))}</span></div><div class="price"><strong>${money(r.quote?.mc)}</strong><small class="${r.receivedAt && state.time - r.receivedAt <= 15 ? "" : "warning"}">${!r.receivedAt ? "等待行情" : state.time - r.receivedAt > 15 ? "暂未刷新" : state.time - r.receivedAt + " 秒前"}</small></div></article>`,
        )
        .join(
          "",
        )}</div>${!rows().length ? `<section class="panel">${empty()}</section>` : ""}`;
  } else if (page === "repair") {
    const count = (lane) =>
      state.jobs
        .filter(
          (j) =>
            j.lane === lane &&
            ["QUEUED", "RUNNING", "BACKOFF"].includes(j.state),
        )
        .reduce((n, j) => n + j.count, 0);
    html +=
      title(
        "数据补齐",
        "自动补充代币资料、首喊基准与喊后高低点。",
        '<button class="primary" id="repair">补齐缺失</button><a href="/api/logs" download><button>导出日志</button></a>',
      ) +
      `<div class="panel"><div class="job-grid">${[
        ["verify", "代币确认"],
        ["metadata", "资料补齐"],
        ["baseline", "首喊基准"],
        ["history", "历史追踪"],
      ]
        .map(
          ([lane, name]) =>
            `<div><span class="subtle">${name}</span><strong>${count(lane)}</strong><span class="token-meta">等待或进行中</span></div>`,
        )
        .join(
          "",
        )}</div><p class="note">暂时查不到的数据会延后重试，已保存的有效结果保留。实时行情独立刷新。</p></div><section class="panel"><h2>统计记录</h2>${state.rows.length ? statsTable(state.rows) : empty()}</section>`;
  } else {
    html +=
      title("设置", "连接监控来源，管理行情与悬浮窗。") +
      `<div class="grid-two"><section class="panel"><h2>行情与悬浮窗</h2><p class="note">悬浮窗当前可见币优先使用 AVE 行情，DEX 补缺并兜底；屏外活跃币由 DEX 主查；后台资料按 AVE→DEX 逐级补查，喊单前价格使用 AVE。AVE 登录状态保存在本机。</p><form id="display-settings" class="form-grid"><label>悬浮窗透明度 <span id="opacity-label">${Math.round(state.settings.opacity * 100)}%</span><input type="range" name="opacity" min="30" max="100" value="${Math.round(state.settings.opacity * 100)}"></label><button class="primary" type="submit">保存设置</button></form><div class="account-line"><span>AVE 内置登录</span><button data-site="ave">打开登录</button></div></section><section class="panel"><h2>监控群组</h2><div class="form-grid"><label>微信监控群<select id="wechat-groups" multiple>${state.settings.monitor.wechat.map((g) => `<option selected value="${escape(g)}">${escape(g)}</option>`).join("")}</select></label><div class="actions"><button id="wechat-load">读取微信群</button><button id="wechat-keys">配置微信读取</button></div><label>Telegram 监控群<select id="telegram-groups" multiple>${state.settings.monitor.telegram.map((g) => `<option selected value="${escape(g.peerId)}">${escape(g.title)}</option>`).join("")}</select></label><div class="actions"><button id="telegram-load">读取 Telegram 群</button><button id="monitor-save" class="primary">保存监控群</button></div></div><p class="note">按住 Ctrl 可选择多个群。新项目从启用监控后开始积累数据。</p></section></div><section class="panel wide-form"><h2>Telegram 登录</h2><p class="subtle" id="telegram-state">状态：${escape({ needs_credentials: "未配置 API", needs_login: "等待登录", ready: "已登录", connected: "已登录", signed_out: "等待登录", code_sent: "等待验证码", password_needed: "等待两步验证", connecting: "正在连接", login_code: "等待验证码", login_password: "等待两步验证", error: "连接异常" }[state.monitor.telegram.state] ?? state.monitor.telegram.state)}${state.monitor.telegram.account ? " · " + escape(state.monitor.telegram.account) : ""}</p><form id="telegram-credentials" class="form-grid"><label>API ID<input name="apiId" inputmode="numeric" autocomplete="off" required></label><label>API Hash<input name="apiHash" type="password" autocomplete="off" required></label><button type="submit">配置 API</button></form><form id="telegram-phone" class="form-grid"><label>手机号（含国家区号）<input name="phone" autocomplete="tel" placeholder="+86…" required></label><button type="submit">发送验证码</button></form><form id="telegram-code" class="form-grid"><label>验证码<input name="code" autocomplete="one-time-code" required></label><button type="submit">验证登录</button></form><form id="telegram-password" class="form-grid"><label>两步验证密码<input name="password" type="password" autocomplete="off" required></label><button type="submit">验证密码</button></form></section>`;
  }
  $("#content").innerHTML = html;
  bind();
}
function bind() {
  document.querySelectorAll("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page;
        render();
      }),
  );
  document.querySelectorAll("[data-copy]").forEach(
    (b) =>
      (b.onclick = () =>
        navigator.clipboard
          .writeText(b.dataset.copy)
          .then(() => toast("地址已复制"))
          .catch(() => toast("复制失败，请手动选择地址"))),
  );
  document
    .querySelectorAll("[data-site]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          perform(
            () => api("/api/site", { provider: b.dataset.site }),
            "登录窗口已打开",
          )),
    );
  document
    .querySelectorAll("[data-overlay]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          perform(
            () => api("/api/desktop", { action: "overlay" }),
            "悬浮窗已打开",
          )),
    );
  const search = $(".search");
  if (search)
    search.oninput = () => {
      query = search.value;
      const start = search.selectionStart;
      render();
      $(".search").focus();
      $(".search").setSelectionRange(start, start);
    };
  if ($("#source-filter"))
    $("#source-filter").onchange = (e) => {
      source = e.target.value;
      render();
    };
  if ($("#repair"))
    $("#repair").onclick = () =>
      perform(() => api("/api/repair", {}), "补齐任务已启动");
  const form = $("#display-settings");
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      perform(
        () =>
          api("/api/settings", {
            opacity: Number(form.opacity.value) / 100,
          }),
        "设置已保存",
      );
    };
    form.opacity.oninput = () =>
      ($("#opacity-label").textContent = form.opacity.value + "%");
    $("#wechat-load").onclick = () => loadGroups("wechat");
    $("#telegram-load").onclick = () => loadGroups("telegram");
    $("#wechat-keys").onclick = () =>
      perform(
        () => api("/api/desktop", { action: "keys" }),
        "微信读取配置已启动",
      );
    $("#monitor-save").onclick = () => {
      const wechat = [...$("#wechat-groups").selectedOptions].map(
        (o) => o.value,
      );
      const telegram = [...$("#telegram-groups").selectedOptions].map((o) => ({
        peerId: o.value,
        title: o.textContent,
      }));
      perform(
        () => api("/api/settings", { monitor: { wechat, telegram } }),
        "监控群已保存",
      );
    };
    for (const [id, action] of [
      ["credentials", "configure"],
      ["phone", "code"],
      ["code", "verify"],
      ["password", "password"],
    ]) {
      const f = $("#telegram-" + id);
      f.onsubmit = (e) => {
        e.preventDefault();
        perform(
          () =>
            api("/api/telegram/" + action, Object.fromEntries(new FormData(f))),
          "登录状态已更新",
        ).then(() => f.reset());
      };
    }
  }
}
async function loadGroups(source) {
  try {
    const groups = await api("/api/groups?source=" + source);
    const box = $("#" + source + "-groups");
    const selected = new Set([...box.selectedOptions].map((o) => o.value));
    box.innerHTML = groups
      .map((g) => {
        const id = g.peerId ?? g.username,
          title = g.title ?? g.displayName ?? id;
        return `<option value="${escape(id)}" ${selected.has(id) ? "selected" : ""}>${escape(title)}</option>`;
      })
      .join("");
    toast("群列表已读取，请选择后保存");
  } catch (e) {
    toast(e.message);
  }
}
async function perform(work, message) {
  try {
    await work();
    toast(message);
    await refresh(true);
  } catch (e) {
    toast(e.message);
  }
}
let loading = false;
async function refresh(force = false) {
  if (loading) return;
  loading = true;
  try {
    state = await api("/api/state");
    $("#connection").textContent = state.demo
      ? "演示模式"
      : `监控 ${state.monitor.wechat.watched + state.settings.monitor.telegram.length} 个群 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    if (page !== "settings" || force || !$("#display-settings")) render();
  } catch (e) {
    $("#connection").textContent = "连接中断";
    toast(e.message);
  } finally {
    loading = false;
  }
}
await refresh();
const events = new EventSource("/api/events");
events.onmessage = () => refresh();
events.onerror = () => ($("#connection").textContent = "正在重新连接");
setInterval(() => refresh(), 5000);

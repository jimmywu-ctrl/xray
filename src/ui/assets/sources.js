// Dashboard sources functions. Shared state remains in the page bootstrap.
async function loadSources(refresh = false) {
  if (sourcesLoading) return;
  sourcesLoading = true;
  try {
    const previous = ready();
    const next = await api('/api/sources' + (refresh ? '?refresh=1' : ''));
    const changed = JSON.stringify(sources) !== JSON.stringify(next);
    sources = next;
    if (!previous && ready()) { gsrc.groups = null; gsrc.error = null; loadGroups(); }
    if (changed) renderGroups();
  } catch (e) {
    const changed = sources?.error !== e.message;
    if (!sources) sources = { error: e.message };
    if (changed) renderGroups();
  } finally { sourcesLoading = false; }
}
// END loadSources
async function sourceAction(action) {
  if (setupBusy) return;
  setupBusy = true; setupError = null; renderGroups();
  try { sources = await api('/api/sources/' + action, { method: 'POST' }); }
  catch (e) { setupError = e.message; }
  setupBusy = false; renderGroups();
}
// END sourceAction
async function collectSourceDiagnostics() {
  if (sourceDebugBusy) return;
  sourceDebugBusy = true; sourceDebugStatus = '正在生成诊断报告…'; renderGroups();
  try {
    sourceDebugReport = JSON.stringify(await api('/api/sources/diagnostics'), null, 2);
    try {
      await navigator.clipboard.writeText(sourceDebugReport);
      sourceDebugStatus = '报告已复制，可用于排查问题。';
    } catch {
      sourceDebugStatus = '报告已生成；自动复制不可用，请手动复制下方内容。';
    }
  } catch (e) {
    sourceDebugStatus = '生成失败：' + e.message;
  } finally {
    sourceDebugBusy = false; renderGroups();
  }
}
// END collectSourceDiagnostics
function chk(state, text, sub) {
  const row = el('div', 'chk' + (state === true ? ' ok' : state === false ? ' bad' : ''));
  const label = el('div', 't');
  row.append(el('i', null, state === true ? '✓' : state === false ? '!' : '·'));
  label.append(document.createTextNode(text));
  if (sub) label.append(el('small', null, sub));
  row.append(label);
  return row;
}
// END chk
function renderSetup(box) {
  if (sources?.error) {
    const notice = el('div', 'notice err');
    notice.append(el('b', null, '微信状态读取失败'), el('code', null, sources.error));
    box.append(notice);
    return;
  }
  const st = sources?.wechat;
  if (!st) { box.append(el('div', 'notice', '正在读取微信状态…')); return; }
  const card = el('div', 'card');
  const heading = el('h2', null, '微信监听');
  heading.append(el('span', 'pill' + (st.ready ? ' ok' : ''), st.ready ? '数据库就绪' : st.health?.degraded ? '部分可用' : '未配置'));
  card.append(heading);
  card.append(el('div', 'lead', '只读本机微信聊天数据库。首次使用需提取数据库密钥；密钥保存在本机应用数据目录。'));
  card.append(chk(st.installed, st.installed ? '已检测到微信数据库' : '未检测到微信数据库', st.installed ? st.dbDir : '请在这台电脑登录 Windows 微信 4.x，再点页面右上角“刷新”。'));
  card.append(chk(st.ready ? true : st.keys ? false : null, '数据库密钥', st.ready ? '密钥可用' : st.keys ? (st.error || '密钥无法打开微信数据库') : '尚未提取'));
  if (st.health) card.append(el('div', 'hint', `会话库：${st.health.sessionReadable ? '可读' : '不可读'} · 消息分片：${st.health.readableMessageFiles}/${st.health.messageFiles} 可读`));
  if (!st.ready && st.error && st.installed) card.append(el('div', 'hint', st.error));
  if (!st.ready) {
    if (st.setupStartedAt) {
      const progress = el('div', 'prog');
      progress.append(el('b', null, 'PowerShell 窗口已打开'), document.createTextNode(' · 按窗口里的提示完成密钥提取。完成后这里会自动更新。'));
      card.append(progress, ghost('重新打开 PowerShell', () => sourceAction('wechat/setup')));
    } else {
      const button = el('button', 'act', '提取微信密钥');
      if (!st.installed) button.textContent = '等待检测到微信数据库';
      button.title = st.installed ? '保持 Windows 微信 4.x 运行后提取本机数据库密钥' : '先登录 Windows 微信 4.x 并刷新，检测到数据库后才能提取';
      button.type = 'button'; button.disabled = setupBusy || !st.installed;
      button.onclick = () => sourceAction('wechat/setup');
      card.append(button);
    }
  }
  const debugToggle = el('button', 'ghost', sourceDebugMode ? '关闭诊断模式' : '开启诊断模式');
  debugToggle.type = 'button'; debugToggle.setAttribute('aria-pressed', String(sourceDebugMode));
  debugToggle.onclick = () => {
    sourceDebugMode = !sourceDebugMode;
    localStorage.setItem('xray:wechat-debug-mode', sourceDebugMode ? '1' : '0');
    if (!sourceDebugMode) { sourceDebugReport = ''; sourceDebugStatus = ''; }
    renderGroups();
  };
  card.append(debugToggle);
  if (sourceDebugMode) {
    const debug = el('div', 'source-debug');
    debug.append(el('p', null, '诊断仅检查系统版本、微信进程、数据库目录和提取工具状态；不会读取聊天内容或密钥。复制报告前会自动打码 Windows 用户名和微信账号目录。'));
    const collect = el('button', 'ghost', sourceDebugBusy ? '正在诊断…' : '生成并复制诊断报告');
    collect.type = 'button'; collect.disabled = sourceDebugBusy; collect.onclick = collectSourceDiagnostics;
    debug.append(collect);
    if (sourceDebugStatus) debug.append(el('div', 'source-debug-status', sourceDebugStatus));
    if (sourceDebugReport) {
      const report = el('pre'); report.textContent = sourceDebugReport; debug.append(report);
    }
    card.append(debug);
  }
  box.append(card);
  if (setupError) {
    const notice = el('div', 'prog err');
    notice.append(el('b', null, '操作失败'), document.createTextNode(' ' + setupError));
    box.append(notice);
  }
}
// END renderSetup

const deliveryTraceForm = document.getElementById('delivery-trace');
if (deliveryTraceForm) {
  const groupSelect = deliveryTraceForm.elements.group;
  const output = deliveryTraceForm.querySelector('output');
  groupSelect.addEventListener('focus', () => {
    const selected = groupSelect.value;
    groupSelect.replaceChildren(new Option('全部来源', ''));
    for (const group of gsrc.groups ?? []) {
      groupSelect.add(new Option(group.displayName || group.username, group.username));
    }
    if ([...groupSelect.options].some(option => option.value === selected)) groupSelect.value = selected;
  });
  deliveryTraceForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = deliveryTraceForm.querySelector('button');
    button.disabled = true;
    output.textContent = '查询中…';
    try {
      const params = new URLSearchParams(new FormData(deliveryTraceForm));
      const result = await api('/api/delivery-trace?' + params);
      const labels = {
        sent: '已有 Bot 转发回执', retrying: '转发失败，等待重试', queued: '等待转发',
        inactive: '消息已撤回或移除该地址', backfilled: '已回读入库，未触发实时转发',
        no_receipt: '已入库，暂无转发回执',
      };
      const lines = result.entries.map(entry =>
        new Date(entry.at * 1000).toLocaleString() + ' · ' +
        (entry.source === 'wechat' ? '微信' : 'Telegram') + ' · ' + labels[entry.status],
      );
      if (result.groupWatched === false) lines.unshift('所选群当前未开启监控。');
      if (!result.entries.length) lines.push('没有找到这条 CA 的入库记录。');
      output.textContent = lines.join('\n');
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

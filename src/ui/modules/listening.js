import { escape, count, metric, setContent } from './shared.js';

export function renderListening(snapshot) {
  const settings = snapshot.settings?.monitor || { wechat: [], telegram: [] };
  const telegram = snapshot.monitor?.telegram || {};
  const wechat = snapshot.monitor?.wechat || {};

  const selectedWechat = Math.max(
    0,
    Number(wechat.selected ?? settings.wechat?.length ?? 0) || 0,
  );
  const readyWechat = Math.max(
    0,
    Number(wechat.ready ?? wechat.running ?? 0) || 0,
  );
  const retryingWechat = Math.max(0, Number(wechat.retrying) || 0);
  const wechatState = selectedWechat === 0
    ? '未监听'
    : readyWechat >= selectedWechat
      ? '监听中'
      : readyWechat > 0
        ? '部分就绪'
        : retryingWechat > 0
          ? '重连中'
          : '启动中';
  const wechatDetail = selectedWechat === 0
    ? '0 个监听群'
    : readyWechat >= selectedWechat
      ? `${count(selectedWechat)} 个监听群`
      : `${count(readyWechat)} / ${count(selectedWechat)} 个群已就绪`;
  const wechatTone = selectedWechat > 0 && readyWechat >= selectedWechat
    ? 'good'
    : 'warn';

  const telegramState = telegram.state === 'connected'
    ? '已连接'
    : telegram.error
      ? '连接异常'
      : '未连接';
  const telegramGroups = Array.isArray(settings.telegram)
    ? settings.telegram.length
    : 0;

  setContent(
    'module-listening',
    '<div class="module-grid two">' +
      metric('微信', wechatState, wechatDetail, wechatTone) +
      metric(
        'Telegram',
        telegramState,
        `${count(telegramGroups)} 个已选群/频道`,
        telegram.state === 'connected' ? 'good' : 'warn',
      ) +
      '</div><div class="card module-panel"><div class="module-heading"><h2>消息进入数据库的流程</h2><span>群组和频道在下方管理</span></div><ol class="module-flow"><li><b>接收消息</b><small>微信 / Telegram</small></li><li><b>识别合约</b><small>确认代币和所属链</small></li><li><b>确认首喊</b><small>保留最早真人归属</small></li><li><b>入库查询一轮</b><small>取得的数据保存，空缺标记</small></li></ol>' +
      (telegram.error
        ? '<p class="module-warning">' + escape(telegram.error) + '</p>'
        : '') +
      '</div>',
  );
}

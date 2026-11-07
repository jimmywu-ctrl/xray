const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function openGmgnChrome(raw, deps = {}) {
  const target = new URL(raw);
  if (target.protocol !== 'https:' || target.hostname !== 'gmgn.ai') throw Error('仅允许 GMGN HTTPS 链接');
  const env = deps.env || process.env;
  const exists = deps.exists || fs.existsSync;
  const executable = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter(Boolean).map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(exists);
  if (!executable) throw Error('未找到 Google Chrome，请先安装 Chrome');
  return new Promise((resolve, reject) => {
    const child = (deps.spawn || spawn)(executable, [target.href], { detached:true, stdio:'ignore', windowsHide:true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
module.exports = { openGmgnChrome };

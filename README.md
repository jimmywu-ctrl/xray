# X-Ray

Windows 桌面喊单监控工具，聚合微信与 Telegram 消息，提供代币悬浮窗、统一首喊归属、行情与后台统计。

本仓库是当前本地部署版本 `20261103-controls-verified` 的源码快照；不包含任何个人账号、聊天记录、群列表、备注、密钥、浏览器会话或运行数据库。示例数据为合成数据。

## 开发运行

需要 Windows、Node.js 24 与 npm。微信读取还需要本机微信和 Python 3.10+；微信版本变化可能需要适配。Google Chrome 用于打开 GMGN。

```powershell
npm ci
npm test
npm run desktop
```

桌面程序会启动独立监控后台，本地页面地址为 `http://127.0.0.1:48876/`。开发实例与已安装程序使用相同端口及默认数据目录，请勿同时启动。

仅运行后台：`npm start`。AVE 内置页面需要 Electron 桌面提供会话，因此仅后台模式不能完整替代桌面行情功能。

## 自行配置

- 微信：在设置中读取本机数据库密钥，选择需要监控的群。
- Telegram：填写自己的 API ID / Hash，再完成手机号与验证码登录。
- 行情：DEX 优先，AVE 内置页面补充资料与历史行情。AVE 页面需要时自行登录；不附带付费 API 密钥。
- Telegram Bot 转发为可选功能，需自行配置 Bot 与目标。

个人运行数据保存在 `%APPDATA%\xray-next`，与源码分离。请勿将该目录复制到仓库。

## 数据口径与结构

微信、Telegram 按链与合约共用最早真人首喊归属；悬浮窗使用最近 24 小时窗口。涨跌幅基于首喊基准，缺少有效基准时显示待补全。网络故障或来源不提供历史证据时，无法保证所有代币都能补齐。

- `src/adapters/`：微信、Telegram 与行情适配。
- `src/services/`：消息采集、归属、行情与统计。
- `src/infra/`：SQLite、独立后台与任务调度。
- `src/ui/`：后台界面和悬浮窗。
- `desktop/`：Electron 外壳、托盘、内置页面会话。
- `scripts/`：本机密钥配置、图标工具与测试入口。
- `test/`：自动化回归。

仓库不包含安装包、Node/Python 运行时、依赖目录、历史验收截图或生产日志。现有 Electron 打包布局需要 `resources/next` 源码和 `resources/node/node.exe`；开发启动可直接使用 npm 安装的 Electron。

## 隐私与验证

见 [发布说明](docs/source-release.md)。第三方微信密钥工具的许可保留于 `scripts/wcdb-key-tool-LICENSE.txt`。

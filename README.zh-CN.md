# cdp-browser-access

[English](README.md) | **简体中文**

让 agent 通过 **CDP 直连你日常使用的浏览器**的 skill。带上你已有的登录态去访问强反爬或需登录的站点，处理 JS 动态渲染、页面交互、截图与视频抽帧。

派生自 [eze-is/web-access](https://github.com/eze-is/web-access)（MIT，作者 一泽Eze）。本 fork 的定位更窄：**只做浏览器那一层**，通用搜索与静态抓取交还给 harness 自带的工具。

## 它解决什么

| 场景 | 用本 skill | 说明 |
|---|---|---|
| 需要登录才能看到的内容 | ✅ | 复用浏览器里的会话，无需配置任何 cookie |
| 强反爬平台（小红书、微信公众号、微博、知乎…） | ✅ | 静态抓取拿不到，走真实浏览器 |
| JS 动态渲染的内容 | ✅ | 等 DOM 里真的出现目标内容再提取 |
| 点击 / 填表 / 上传 / 滚动懒加载 / 翻页 | ✅ | |
| 页面截图、视频抽帧 | ✅ | |
| 从你自己的书签 / 历史里定位 URL | ✅ | "我上次看的那个页面"、内网系统 |
| 常规搜索、已知 URL 读正文、读文档 | ❌ | **改用 harness 自带的搜索 / 抓取工具**，更快也更稳 |

## 前置条件

- **Node.js 22+**（使用原生 WebSocket）
- 已安装 Chromium 系浏览器（Chrome / Edge / Chromium / Chrome Canary）
- **手动开启一次远程调试开关**（必须，无法由程序自动完成）：
  在目标浏览器地址栏访问 `chrome://inspect/#remote-debugging`
  （Edge 为 `edge://inspect/#remote-debugging`），勾选
  `Allow remote debugging for this browser instance`。
  首次连接可能出现授权弹窗，点「允许」即可。
- macOS 需要可用的 `sqlite3`（系统自带，或 conda / Homebrew 提供的都行），用于读取浏览器历史

### 其它 Chromium 浏览器（Arc）

Chrome / Chrome Canary / Chromium / Edge 都通过各自在 `chrome://inspect#remote-debugging` 开关打开时写下的 `DevToolsActivePort` 文件被发现。

**Arc 不走这条路：**

- Arc 自带的 `arc://inspect#remote-debugging` 开关虽然也会开出端口并写 `DevToolsActivePort`，但**那个服务器无条件拒绝外部 CDP 连接** —— 实测在 Origin / User-Agent / Host / 子协议的各种组合下都是 `HTTP 403 Connection rejected`。
- 带 `--remote-debugging-port` 启动时，Arc 能正常提供 CDP —— 但它此时**不会更新** `DevToolsActivePort`，所以也没法靠那个文件发现。

因此 Arc 必须带调试参数启动：

```bash
osascript -e 'tell application "Arc" to quit'
open -a Arc --args --remote-debugging-port=9333
```

之后即可显式指定：

```bash
node scripts/check-deps.mjs --browser arc
# 或持久化：在 config.env 里写 WEB_ACCESS_BROWSER=arc

# 切换浏览器需要重启常驻的 proxy：
pkill -f cdp-proxy.mjs && node scripts/check-deps.mjs
```

Chrome 与 Arc 可以同时运行，按各自占用的端口区分（Arc 默认 9333，Chrome 默认 9222）：

```text
已开启远程调试：Chrome (chrome, port 9222)、Arc (arc, port 9333)
```

> Arc 不写 Chrome 格式的 `Bookmarks`，其 Chrome 格式 `History` 也几乎没有内容。因此 `find-url` 改为直接读 Arc 自己的存储：固定标签取自 `StorableSidebar.json`（字段 `data.tab.savedURL`），归档/已关闭标签取自 `StorableArchiveItems.json`。两者都是尽力解析 —— 若 Arc 改了格式，读取器会降级为空结果而不是报错。

### 默认用哪个浏览器

若 `config.env` 未设置 `WEB_ACCESS_BROWSER`，**在有 Chrome 的情况下优先用 Chrome**。若 Chrome 没开调试但恰好只有一个别的浏览器可用，则用那一个。只有当多个浏览器可用、且其中没有 Chrome 时，skill 才会询问你选哪个。

## 安装

skill 就是一个目录，放进对应 harness 的 **skills 根目录**即可。

| harness | 放到哪里 |
|---|---|
| **Claude Code** | `~/.claude/skills/cdp-browser-access/`（项目级：`<repo>/.claude/skills/`） |
| **OpenAI Codex** | `~/.agents/skills/cdp-browser-access/` 或 `~/.codex/skills/cdp-browser-access/` |
| **DeepSeek Harness** | `~/.agents/skills/cdp-browser-access/` 或 `~/.dsh/skills/cdp-browser-access/` |

`~/.agents/skills/` 是 **Claude Code 之外的跨 harness 约定** —— Codex 与 DeepSeek Harness 都会读取它。

```bash
git clone https://github.com/CharlesXu-HQ/cdp-browser-access.git /tmp/cdp-browser-access
mkdir -p ~/.agents/skills
cp -R /tmp/cdp-browser-access ~/.agents/skills/cdp-browser-access
rm -rf /tmp/cdp-browser-access

# Claude Code 需要单独放一份；推荐软链，保持单一真源
mkdir -p ~/.claude/skills
ln -s ~/.agents/skills/cdp-browser-access ~/.claude/skills/cdp-browser-access
```

> **Claude Code 不会自动读取 `~/.agents/skills/`。** 它只把该目录当作 `/import` 的导入来源。
> 实测其技能搜索路径为 `managed` + `~/.claude/skills` + `<project>/.claude/skills`。

如果你的 harness 支持 skills CLI（如 `npx skills add`），也可以直接指向本仓库。

## 使用

安装后正常提问即可，harness 会依据 `SKILL.md` 的 description 自动判断是否触发。完整用法、Proxy API、站点经验机制见 [`SKILL.md`](./SKILL.md)。

## 诊断

连不上浏览器时，先跑这个：

```bash
node scripts/cdp-proxy.mjs --probe-only 9222
```

它会对指定调试端口逐个候选做**真实 WebSocket 握手**探测并打印结果，不启动服务。

## 安全须知

- **本 skill 会操作你的真实浏览器**，因此携带你的全部登录态。请只在你信任的机器上使用。
- 部分站点对自动化检测严格，**存在账号封禁风险**。
- 本地 proxy 监听 `127.0.0.1:3456`，**不对外网暴露**，但**当前没有鉴权与 Origin 校验** ——
  本机上的其它进程可以调用它的 API 操作你的浏览器。介意的话请自行加 token 或用防火墙限制。
- 读取浏览器书签 / 历史时会要求必须带关键词；**禁止无关键词调用**，否则会把最近全部浏览记录读出来。

## 目录结构

```
SKILL.md                     用法说明（agent 触发时读这个）
README.md                    English README（默认）
README.zh-CN.md              中文说明
NOTICE.md                    上游署名、改动清单、修复记录
LICENSE                      MIT
config.env                   运行时生成的浏览器偏好（已 gitignore）
scripts/
  check-deps.mjs             前置检查 + 启动/复用 CDP proxy
  cdp-proxy.mjs              CDP proxy 主体（连接浏览器、代理 HTTP API）
  browser-discovery.mjs      调试端口发现与浏览器选择（被上面两个共享）
  find-url.mjs               检索本地浏览器的书签 / 历史
  match-site.mjs             按用户输入匹配站点经验文件（上游遗留工具，SKILL.md 未引用）
references/
  cdp-api.md                 CDP API 与 JS 提取模式参考
  migration-2.5.3.md         `/new`、`/navigate` 改 POST body 的迁移指南
  site-patterns/             按域名积累的站点经验（使用中生成，已 gitignore）
templates/
  config.env.template        config.env 的模板
```

## 与上游的差异

改动清单与修复记录见 [`NOTICE.md`](./NOTICE.md)。

## 许可

MIT。原始版权归 一泽Eze（[eze-is/web-access](https://github.com/eze-is/web-access)）所有，
本 fork 的修改版权归 Charles xu。详见 [`LICENSE`](./LICENSE)。

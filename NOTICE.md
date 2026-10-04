# 来源与署名

本 skill（`cdp-browser-access`）是以下项目的二次开发版本（fork）：

- **上游项目**：https://github.com/eze-is/web-access
- **上游作者**：一泽Eze
- **上游版本**：2.5.4（本 fork 基于此版本）
- **上游声明许可**：MIT

上游仓库在 `SKILL.md` frontmatter 与 `.claude-plugin/plugin.json` 中均声明 MIT 许可，
但仓库根目录未包含独立的 `LICENSE` 文件（GitHub API 的 `license` 字段为 `null`）。
本 fork 按上游声明的 MIT 条款使用与再分发，并在此保留原作者署名。

## 本 fork 的改动范围

| 部分 | 是否改动 |
|---|---|
| `scripts/cdp-proxy.mjs` | **已改动**：修复固定调试端口兜底路径的 WebSocket URL 拼接 bug（见下） |
| `scripts/browser-discovery.mjs` | 未改动，原样使用 |
| `scripts/check-deps.mjs` | 未改动，原样使用 |
| `scripts/find-url.mjs` | 未改动，原样使用 |
| `scripts/match-site.mjs` | 未改动，原样使用 |
| `references/cdp-api.md` | 未改动，原样使用 |
| `templates/config.env.template` | 未改动，原样使用 |
| `SKILL.md` | **已改写**（剥离重叠层、收窄触发、书签/历史检索前置） |

### 改动清单

本 fork 相对上游 v2.5.4 的改动：

1. **剥离重叠层**：移除原「联网工具选择」表中的 `WebSearch` / `WebFetch` 引导、Jina（`r.jina.ai`）预处理层，
   以及「信息核实类任务」整节（该节讲的是搜索引擎定位一手来源）。这些能力由 harness 原生提供。
   `curl` 仅保留为「下载已定位的媒体资源」用途。
2. **收窄触发**：skill 由 `web-access` 更名为 `cdp-browser-access`，description 改为排除式，
   明确不承担通用搜索与静态抓取。
3. **本地书签/历史检索前置**：原版把该能力放在「补充：本地浏览器资源」，仅在特定场景提及；
   现提升为**步骤 0：目标归属判断**，并补充了硬性约束（禁止无关键词查询、查不到不重试等）。
4. **harness 中性化**：路径与工具描述不再绑定单一 harness。`SKILL.md` 的路径约定同时给出三种取根目录的方式 ——
   Claude Code（`${CLAUDE_SKILL_DIR}`，由 Claude Code 自动替换）、DeepSeek Harness（加载时给出的 `Base directory`）、
   Codex（skills 列表中的 `file:` 路径）。
5. **修复兜底连接 bug**（`scripts/cdp-proxy.mjs`）：固定调试端口的兜底路径拼出的 WebSocket URL
   缺少 browser UUID，被 Chrome 以非 101 状态码拒绝，导致连接必然超时。详见下一节。
6. **支持 Arc，并能与 Chrome 区分指定**（`browser-discovery.mjs`、`check-deps.mjs`、`find-url.mjs`）：
   - 新增 Arc 条目与 `flagPorts` 机制。原因是实测发现 Arc 的行为与其它 Chromium 不同：
     它自带的 `arc://inspect#remote-debugging` 开关会开端口并写 `DevToolsActivePort`，但该服务器
     **无条件拒绝外部 CDP 连接**（403）；而带 `--remote-debugging-port` 启动时它**不更新**该文件。
     因此 Arc 既不能靠文件发现，也不能用自带开关，只能按固定端口发现。
   - 发现逻辑改为**两轮**：第一轮按各浏览器的 `DevToolsActivePort` 认领端口（TCP 存活即认，
     wsPath 取自该文件，与上游行为一致）；第二轮让只有 `flagPorts` 的浏览器认领剩余端口，
     且要求 `GET /json/version` 能给出 wsPath。先认领再兜底，避免把 Chrome 的 9222 误记到 Arc 头上。
   - **发现阶段绝不发起 WebSocket**：上游原注释已指出 WebSocket 连接会触发浏览器的
     「远程调试授权」提示；若在发现阶段反复探测，用户会被反复要求授权。
     故可用性判据改用 HTTP `GET /json/version` —— 它同样能排除「端口开着但拒绝外部连接」的端点
     （Arc 开关模式的服务器对其返回 403/404），却不产生任何 WebSocket 连接。
     `cdp-proxy.mjs` 的兜底路径也一并改为优先直接采用 `/json/version` 给出的路径，
     仅在拿不到时才去试短路径，把 WebSocket 连接数压到最低。
   - 指定浏览器失败时的报错改为输出该浏览器专属的 `launchHint`（Arc 提示用带参启动并说明开关不可用）。
   - 修正上游遗留 bug：原版把浏览器 id 当作 URL scheme，会输出 `chrome-canary://inspect` 这类无效地址，
     现改为 Edge 用 `edge://`、其余用 `chrome://`。
   - **未指定浏览器时默认选 Chrome**：原版在检测到多个浏览器时一律询问用户；现改为优先 Chrome，
     Chrome 不在场且仅有一个候选时自动选它，只有候选之间真正有歧义时才询问。
   - `find-url` 新增 Arc 专有读取：Arc 不写 Chrome 格式的 `Bookmarks`，其数据在
     `StorableSidebar.json`（固定标签，字段 `data.tab.savedURL`）与
     `StorableArchiveItems.json`（归档 ≈ 历史，字段 `sidebarItem.data.tab.savedURL`）中，
     格式为「数组当字典 + 判别式联合」，时间为 CFAbsoluteTime。解析失败静默降级为空结果。

## 修复与重写：固定调试端口兜底连接

**现象**：当浏览器不是通过 `DevToolsActivePort`（即 `chrome://inspect#remote-debugging` 开关）暴露，
而是手动以 `--remote-debugging-port=<port>` 启动时，proxy 反复报
`连接错误: Received network error or non-101 status code`，最终超时退出。

**原因（两层）**：

1. `getWebSocketUrl()` 在 `wsPath` 为 null 时硬拼 `ws://127.0.0.1:<port>/devtools/browser`。
   这个短路径**并非对所有 Chrome 实例都有效**：headless Chrome 只接受带 UUID 的全路径
   `/devtools/browser/<uuid>`，而真实 Chrome 两者都接受（短路径同样返回 101）。
   原实现没有任何候选探测，撞上不支持短路径的实例必然失败。
2. 失败后每次重试只报同一句不透明的错误，不指出该怎么处理。

**修复（重写兜底路径）**：

- 新增 `fetchBrowserWsPath(port)`：向 `/json/version` 询问带 UUID 的全路径，拿不到返回 null。
- 新增 `probeBrowserWs(port, wsPath)`：对候选做**一次真实 WebSocket 握手**（连上即断开），
  返回成功/失败与原因；兼容浏览器式（`addEventListener` / `onopen`）与 node 式（`on`）事件 API。
- 新增 `resolveFallbackWsPath(port)`：按「全路径 → 短路径」顺序逐候选握手，返回第一个能通的；
  全失败则返回原因与已试数量。兜底分支据此决定连接参数，失败时抛出可操作的错误信息。
- 新增诊断入口 `node scripts/cdp-proxy.mjs --probe-only <port>`：打印各候选探测结果后退出
  （不启动服务），用于排查连接问题。

**验证（三种环境实测）**：

| 环境 | `/json/version` | 选中候选 | 结果 |
|---|---|---|---|
| 真实 Chrome（开关模式，9222） | 不可用（HTTP 404） | 短路径 `/devtools/browser` | ✅ 握手成功 |
| headless Chrome（`--remote-debugging-port=9333`） | 提供全路径 | 完整路径（优先） | ✅ 握手成功 |
| 无服务端口（9999） | 不可用 | 全部失败 | ✅ exit 1，原因明确 |

**修正说明**：本文件早前版本曾断言「真实非 headless Chrome 的兜底场景可能仍然失败」。
该结论已被实测推翻 —— 真实 Chrome 的短路径返回 `101 WebSocket Protocol Handshake`
（普通 GET 得到 404 只是因为未发起升级请求）。故兜底路径在两类 Chrome 上均可工作。

**影响面**：走 `DevToolsActivePort` 的主路径（用户日常通过 `chrome://inspect` 开关启用的方式）
不受本次改动影响，已在真实 Chrome 完成回归：
`/new`、`/eval`（读 DOM + 写 DOM）、`/screenshot`、`/close` 全部成功，操作前后标签页数一致。

## 许可

本 fork 同样以 MIT 许可分发。原始版权归 一泽Eze 所有。

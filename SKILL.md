---
name: cdp-browser-access
license: MIT
github: https://github.com/eze-is/web-access
description:
  仅当任务需要「真实浏览器 / 登录态 / 动态渲染 / 页面交互」时使用，通过 CDP 直连用户日常浏览器完成访问。
  触发场景：访问必须登录或强反爬的站点（小红书、微信公众号、微博、知乎等）、页面内容需 JS 渲染才出现、
  需要点击/填表/滚动等页面内操作、需要页面截图或视频抽帧、需要从本地浏览器书签/历史定位一个 URL
  （"我上次看的那个页面"、"我们公司那个某某系统"）。
  不适用：常规搜索、已知 URL 的静态抓取、读文档或 README —— 这些一律用当前 harness 原生的联网能力，
  不要触发本 skill。
metadata:
  author: 一泽Eze
  upstream: https://github.com/eze-is/web-access
  upstream_version: "2.5.4"
  version: "3.0.0-dsh.4"
  fork_note: harness 中性定制版（DSH 为主，同时可用于 Codex）：剥离与 harness 原生工具重叠的搜索/抓取层，收窄触发条件，本地书签/历史检索提升为条件性第一步
---

# cdp-browser-access Skill

> **路径约定**：本文档中所有命令的相对路径都相对**本 skill 根目录**。该目录在不同 harness 下的取得方式：
>
> | harness | 如何得到 skill 根目录 |
> |---|---|
> | **Claude Code** | 本文档中的 `${CLAUDE_SKILL_DIR}` 会被 Claude Code **自动替换**为真实路径。可直接 `cd "${CLAUDE_SKILL_DIR}"` |
> | **DeepSeek Harness** | 加载本 skill 时给出的 `Base directory` |
> | **Codex** | skills 列表中本条目后面的 `file:` 路径（取所在目录） |
>
> 拿到后先 `cd` 到该目录，再执行下文的相对路径命令。所有脚本用 `import.meta.url` 自定位，
> 因此相对调用与绝对调用都可正常工作。

## 触发边界（先自我检查）

**命中以下任一，才用本 skill：**

- 目标站点需要登录态才能看到内容，或对自动化有强反爬（小红书、微信公众号、微博、知乎、B 站等）
- 页面内容是 JS 动态渲染的，静态抓取拿不到
- 需要真实交互：点击、填表、上传文件、滚动懒加载、翻页
- 需要页面截图、视频抽帧、视觉判断
- 需要从**用户自己的**书签/历史里定位 URL

**命中以下任一，立刻放弃本 skill，改用当前 harness 原生的联网能力：**

| 需求 | 用什么 |
|---|---|
| 搜信息、找来源、关键词查询 | harness 自带的搜索。DSH 下为 `web_search` / `advanced_search` / `multi_search` / `platform_search` |
| 已知 URL，取页面正文 | harness 自带的抓取。DSH 下为 `web_fetch` |
| 读文档、README、API 参考 | 同上，或直接读文件 |
| 要原始 HTML 源码看 meta / JSON-LD | 同上，或 bash 里 curl |

> Codex 等其它 harness 没有上表中的同名工具，改用其自带的搜索与 URL 读取能力即可。
> 判断标准不变：**本 skill 只在需要真实浏览器时才介入。**

本 skill **不承担**通用搜索与静态抓取职责。把这两类任务交给它，只会更慢、更容易触发风控。

## 前置检查

在开始 CDP 操作前，先检查可用性：

```bash
node scripts/check-deps.mjs
```

**Node.js 22+** 必需（使用原生 WebSocket）。

按脚本输出处理：

- `exit 0` → 继续
- `exit 2` → 需询问用户偏好，把选择写入 `config.env` 的 `WEB_ACCESS_BROWSER`
- `exit 1` → 按 stdout 的错误信息处理。若其中包含「Agent 处理顺序」，按其步骤执行（例如先用系统命令打开浏览器后重跑）；能自动解决就不要打扰用户，仍失败再求助

支持参数 `--browser <chrome|edge>` 表达本次临时覆盖（不写 config.env）。

切换浏览器时，proxy 是长驻进程，需先 `pkill -f cdp-proxy.mjs` 再重跑 check-deps。

检查通过后，**必须在回复中向用户直接展示以下须知**，再启动 CDP 执行操作：

```
温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。
```

## 步骤 0：目标归属判断（在做任何浏览器操作之前完成）

打开浏览器之前，先判断「目标 URL 是否已经确定」。这一步很便宜，能避免大量无效操作。

| 情况 | 做法 |
|---|---|
| 用户给了**明确 URL** | 直接使用，跳过本步 |
| 用户给了**明确站点 + 明确意图**（"在小红书搜 XX"、"打开知乎那个问题"） | 直接进 CDP，跳过本步 |
| 用户用**指代性说法**指向自己访问过的页面（"我上次看的那个"、"之前打开过的 XX 面板"、"我们公司那个 YY 系统"） | **先跑 find-url 解析 URL**，再进 CDP |
| 目标是**公网搜不到的**（内网系统、SSO 后台、私有域名） | **先跑 find-url** |

```bash
node scripts/find-url.mjs <关键词...> [--only bookmarks|history] [--limit N] [--since 7d] [--sort recent|visits] [--browser chrome|edge]
```

关键词空格分词、多词 AND，匹配 title + url；默认遍历所有已安装的 Chromium 系浏览器（Chrome、Edge）；
`--since` / `--sort` 仅作用于历史，默认按最近访问倒序，`--sort visits` 按访问次数排序。

### 本步的硬性约束（必须遵守）

1. **绝不允许不带关键词调用 find-url。** 无关键词时历史查询会退化成「返回最近全部浏览记录」，
   既泄露用户隐私，又把无关内容灌进上下文。
2. **关键词取自用户原话**，不要自行扩写或翻译。用户说"那个讲 agent 的文章"，就用 `agent` 这类词去试。
3. **查不到就立刻停止本步，不要反复换词重试。** 匹配是基于子串的 AND，能力有限，重试收益极低。
   查不到时直接问用户，或请其给出 URL。
4. **find-url 只返回 URL / 标题 / 访问时间，不返回网页内容。** 拿到 URL 后仍然要进 CDP 取内容。
5. **结果是「候选 URL」，不等于「已找到目标」。** 多个候选且无法判断时，把候选列给用户选，不要自行猜。

## 浏览哲学

**像人一样思考，兼顾高效与适应性的完成任务。**
带着目标进入，边看边判断，遇到阻碍就解决，发现内容不够就深入——全程围绕「我要达成什么」做决策。

**① 拿到请求** — 先明确用户要什么，定义成功标准：什么算完成了？需要拿到什么信息、执行什么操作、达到什么结果？这是后续所有判断的锚点。

**② 选择起点** — 根据任务性质和平台特征，选最可能直达的方式作为第一步。需要登录态、需要页面操作、
已知静态方式不可达的平台（小红书、微信公众号等）→ 直接 CDP，不要在静态层上浪费轮次。

**③ 过程校验** — 每一步的结果都是证据，不只是成功/失败的二元信号。用结果对照①的成功标准更新判断：
路径在推进吗？结果的整体面貌（质量、相关度、量级）是否指向目标可达？发现方向错了立即调整，
不在同一个方式上反复重试——页面缺少预期元素、API 报错、重试无改善，都是在告诉你该重新评估方向。
遇到弹窗、登录墙等障碍，判断它是否真的挡住了目标：挡住了就处理，没挡住就绕过——内容可能已在 DOM 中，交互只是展示手段。

**④ 完成判断** — 对照成功标准确认完成后才停止，但也不要过度操作，不为了"完整"而浪费代价。

## 浏览器 CDP 模式

通过 CDP Proxy 直连用户日常浏览器（Chrome / Edge / Chromium 等 Chromium 系），天然携带登录态，无需启动独立浏览器。

若无用户明确要求，**不主动操作用户已有 tab**，所有操作都在自己创建的后台 tab 中进行，保持对用户环境的最小侵入。
不关闭用户 tab 的前提下，完成任务后关闭自己创建的 tab。

### 启动

```bash
node scripts/check-deps.mjs
```

脚本依次检查 Node.js、浏览器调试端口，并确保 Proxy 已连接（未运行则自动启动并等待）。Proxy 启动后持续运行。

> **前置条件（改不掉）**：目标浏览器需开启远程调试开关 —— 地址栏访问
> `chrome://inspect/#remote-debugging`（Edge 为 `edge://inspect/#remote-debugging`），
> 勾选 "Allow remote debugging for this browser instance"。首次连接可能弹出授权框，需用户点「允许」。

### Proxy API

所有操作通过 curl 调用本地 HTTP API：

```bash
# 列出用户已打开的 tab
curl -s http://localhost:3456/targets

# 创建新后台 tab（自动等待加载）— URL 走 POST body，避免目标 URL 含 query 时被切分
curl -s -X POST --data-raw 'https://example.com' http://localhost:3456/new

# 页面信息
curl -s "http://localhost:3456/info?target=ID"

# 执行任意 JS：可读写 DOM、提取数据、操控元素、触发状态变更、提交表单、调用内部方法
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'

# 捕获页面渲染状态（含视频当前帧）
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"

# 导航（URL 走 POST body，target 走 query）、后退
curl -s -X POST --data-raw 'https://example.com' "http://localhost:3456/navigate?target=ID"
curl -s "http://localhost:3456/back?target=ID"

# 点击（POST body 为 CSS 选择器）— JS el.click()，简单快速，覆盖大多数场景
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'

# 真实鼠标点击 — CDP Input.dispatchMouseEvent，算用户手势，能触发文件对话框
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'button.upload'

# 文件上传 — 直接设置 file input 的本地文件路径，绕过文件对话框
curl -s -X POST "http://localhost:3456/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'

# 滚动（触发懒加载）
curl -s "http://localhost:3456/scroll?target=ID&y=3000"
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"

# 关闭 tab
curl -s "http://localhost:3456/close?target=ID"
```

进入浏览器层后，`/eval` 就是你的眼睛和手：

- **看**：用 `/eval` 查询 DOM，发现页面上的链接、按钮、表单、文本内容
- **做**：用 `/click` 点击元素、`/scroll` 滚动加载、`/eval` 填表提交
- **读**：用 `/eval` 提取文字；判断图片/视频是否承载核心信息——是则取媒体 URL 定向读取，或 `/screenshot` 视觉识别

### 页面就绪与完成判断

`/new` 或 `/navigate` 返回，只代表浏览器完成了当前文档的基础加载，**不代表用户需要的内容已经出现**。
HTTP 200、`document.readyState === "complete"`、页面标题出现、导航调用成功，都不能单独作为完成标准。

导航后先用 `/eval` 检查目标内容。若目标内容尚未出现，而页面仍是空白、加载态、验证页、登录跳转
或其它可能继续变化的中间状态，在默认 15 秒窗口内持续观察 URL、标题和 DOM；页面跳转或内容变化后重新判断。
只有目标内容已获取，或观察窗口结束后仍存在明确阻碍，才能继续提取或报告失败。

站点经验可提供更精确的选择器和等待条件，但只用于加速判断；即使没有站点经验，也必须遵守上述规则。

### 页面内导航

- **`/click`**：在当前 tab 内点击用户视角中的可交互单元，简单直接，串行处理。适合同页连续操作（展开、翻页、进详情）
- **`/new` + 完整 URL**：用目标链接的完整地址在新 tab 中打开，适合同时访问多个页面

很多网站的链接包含会话相关参数（如 token），这些是正常访问所必需的。提取 URL 时应保留完整地址，
不要裁剪或省略参数。URL 通过 POST body 原样传入 `/new` 或 `/navigate`。

> **v2.5.3 迁移提示**：若引用的站点经验文件或其它脚本中仍含 `GET /new?url=...` 或
> `/navigate?target=...&url=...` 的旧写法，调用会收到迁移指引。按
> [`references/migration-2.5.3.md`](references/migration-2.5.3.md) 就地改写为 POST body 后再使用。

### 媒体资源提取

判断内容在图片里时，用 `/eval` 从 DOM 直接拿图片 URL，再定向读取——比全页截图精准得多。

拿到媒体 URL 后，**公开资源**可用 `curl -o` 下载到本地再读取；**需要登录态才可获取**的资源，
才需要在浏览器内 navigate + screenshot。

> `curl` 在本 skill 中**仅用于下载已定位的媒体资源**，不用于页面抓取——页面抓取请用 harness 原生 `web_fetch`。

### 技术事实

- 页面中存在大量已加载但未展示的内容——轮播中非当前帧的图片、折叠区块的文字、懒加载占位元素等。
  以数据结构（容器、属性、节点关系）为单位思考，可以直接触达这些内容。
- DOM 中存在选择器不可跨越的边界（Shadow DOM 的 `shadowRoot`、iframe 的 `contentDocument` 等）。
  eval 递归遍历可一次穿透所有层级，返回带标签的结构化内容，适合快速了解未知页面的完整结构。
- `/scroll` 到底部会触发懒加载，使未进入视口的图片完成加载。提取图片 URL 前若未滚动，部分图片可能尚未加载。
- 短时间内密集打开大量页面（如批量 `/new`）可能触发网站的反爬风控。
- 平台返回的"内容不存在""页面不见了"等提示不一定反映真实状态，也可能是访问方式的问题
  （URL 缺失必要参数、触发反爬），而非内容本身的问题。

### 视频内容获取

用户浏览器真实渲染，截图可捕获当前视频帧。通过 `/eval` 操控 `<video>` 元素
（获取时长、seek 到任意时间点、播放/暂停/全屏），配合 `/screenshot` 采帧，可对视频内容做离散采样分析。

### 登录判断

用户日常浏览器天然携带登录态，大多数常用网站已登录。

登录判断的核心问题只有一个：**目标内容拿到了吗？**

打开页面后先尝试获取目标内容。只有当确认**目标内容无法获取**且判断登录能解决时，才告知用户：

> "当前页面在未登录状态下无法获取[具体内容]，请在你的浏览器中登录 [网站名]，完成后告诉我继续。"

登录完成后无需重启任何东西，直接刷新页面继续。

### 任务结束

用 `/close` 关闭自己创建的 tab，**必须保留用户原有的 tab 不受影响**。

Proxy 持续运行，不建议主动停止——重启后需要在浏览器中重新授权 CDP 连接。

## 并行调研：子 Agent 分治策略

任务包含多个**独立**调研目标时（如同时调研 N 个来源），鼓励分治给子 Agent 并行执行，而非主 Agent 串行处理。

**好处**：多子 Agent 并行，总耗时约等于单个子任务时长；抓取内容不进主 Agent 上下文，主 Agent 只收摘要，省 token。

**并行 CDP 操作**：每个子 Agent 在同一个用户浏览器实例中自行 `/new` 创建后台 tab，自行操作，结束自行 `/close`。
所有子 Agent 共享一个浏览器、一个 Proxy，通过不同 targetId 操作不同 tab，无竞态风险。

**子 Agent Prompt 写法：目标导向，而非步骤指令**

- 子 Agent prompt 中必须写明 `必须加载 cdp-browser-access skill 并遵循指引`，子 Agent 会自动加载 skill，
  无需复制 skill 内容或指定路径。
- 主 Agent 的职责是说清楚**要什么**，仅在必要与确信时限定**怎么做**。过度指定步骤会剥夺子 Agent 的判断空间。
- 写 prompt 时描述目标（「获取」「调研」「了解」），避免用暗示具体手段的动词。

**分治判断标准：**

| 适合分治 | 不适合分治 |
|---|---|
| 目标相互独立，结果互不依赖 | 目标有依赖关系，下一个需要上一个的结果 |
| 每个子任务量足够大（多页抓取、多轮交互） | 简单单页查询，分治开销大于收益 |
| 需要 CDP 浏览器或长时间运行的任务 | 几次静态抓取就能完成的轻量查询 |

## 站点经验

操作中积累的特定网站经验，按域名存储在 `references/site-patterns/` 下。

确定目标网站后，如果前置检查输出的 site-patterns 列表中有匹配的站点，**必须读取对应文件**获取先验知识
（平台特征、有效模式、已知陷阱）。经验内容标注了发现日期，当作**可能有效的提示**而非保证——
如果按经验操作失败，回退通用模式并更新经验文件。

CDP 操作成功完成后，如果发现了有必要记录经验的新站点或新模式（URL 结构、平台特征、操作策略），
主动写入对应的站点经验文件。**只写经过验证的事实，不写未确认的猜测。**

文件格式：

```markdown
---
domain: example.com
aliases: [示例, Example]
updated: 2026-03-19
---
## 平台特征
架构、反爬行为、登录需求、内容加载方式等事实

## 有效模式
已验证的 URL 模式、操作策略、选择器

## 已知陷阱
什么会失败以及为什么
```

## References 索引

| 文件 | 何时加载 |
|------|---------|
| `references/cdp-api.md` | 需要 CDP API 详细参考、JS 提取模式、错误处理时 |
| `references/site-patterns/{domain}.md` | 确定目标网站后，读取对应站点经验 |
| `references/migration-2.5.3.md` | 遇到旧版 GET 写法报错时 |

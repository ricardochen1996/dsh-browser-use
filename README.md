# @rc/dsh-browser-use

> 给 **DeepSeek Harness** 装上"能看、能点"的浏览器：页面被读成一张**带索引的动作空间表**，模型每步只做一个操作、只对一个观测到的目标。

这是一个 **DSH 插件**（host 半 + Web 端半），本身不含浏览器逻辑——它把请求交给 [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) 引擎（本机 checkout 或已安装的 Python 包）执行，因此只有**一份**循环实现。

---

## 仓库结构

```text
dsh-browser-use/
├── lib/          Node 半：index.js（装配 + 委派）/ tools.js（工具与委派工具）/
│                 sessions.js（浏览器所有权、attach 独占）/ sidecar.js（进程、取消、代次）/
│                 engine.js（解释器与环境探测）/ inspector.js + client.js（右侧栏面板）
├── bin/          doctor：安装后一条命令自检
├── sidecar/      Python 半：bridge.py —— 唯一 import 引擎的地方
├── test/         Node 检查（plugin.mjs / delegation.mjs / inspector.mjs）+ Python 检查（pytest + 两个 e2e）
├── pyproject.toml / uv.lock   sidecar 的 Python 环境（引擎作为 path 依赖）
└── package.json  DSH 插件清单（dsh.bundle / dsh.client）
```

引擎（`jev_ultrafast`）是**另一个独立仓库**，这里只依赖它，不含它的任何代码。

## 一、它提供什么

**浏览器操作不在主 agent 手里。** 对话里只有两个工具：

| 工具 | 作用 |
| --- | --- |
| `browser_task` | 把一个目标交给子 agent：它读页面、点、输入、核对，最后回报**验证过的结论**。同一 Session 的所有任务复用同一个浏览器 |
| `browser_doctor` | 自检：解释器、引擎版本、浏览器、委派状态、以及每一项缺失的修复命令 |

浏览器工具挂在**被委派的子 agent 的 scope** 里（默认 6 个，`browser_goal` 关闭时）。只有它看得见、只有它能调用：

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 在**本 Session 独占的浏览器**里打开页面，返回动作空间表 |
| `browser_page` | 重新观测，给出新的观测编号 |
| `browser_act` | 对某个观测里的某个目标执行一次操作：`CLICK` / `TYPE_TEXT` / `SELECT` / `SCROLL_UP` / `SCROLL_DOWN` / `WAIT` |
| `browser_screenshot` | 截取可视区域（图片附件） |
| `browser_console` | 读取控制台消息、页面异常、失败请求与 4xx/5xx |
| `browser_goal` | 把整个目标交给 TypeSafe 策略一次跑完（**默认关闭**，会消耗付费额度） |
| `browser_close` | 关掉标签页、浏览器与 daemon |

组合里没有可用的 subagent provider 时（或 `delegate: false`），插件退回**直接模式**：浏览器工具挂到组合上，对话框里自己调用——同一份实现，只是不经过子 agent。

子 agent 看到的东西长这样（真实输出）：

```text
Page https://www.baidu.com/ — 百度一下，你就知道
Observation 3. Targets below are valid only for this observation.
[13] textbox 国台办回应鲁比奥涉台言论 — TYPE_TEXT, CLICK
[14] button 百度一下 — CLICK
Without a target: WAIT
```

右侧栏还有一个 **Browser agent** 标签页：地址、实时截图、元素表、最后一个动作，看的就是工具正在操作的那个页面。

---

## 二、优势

### 1. 目标来自观测，不是模型编出来的
模型输出的是 `(操作, 索引)`，**永远不是 selector、坐标或 JavaScript**。对照之下，Playwright MCP / Chrome DevTools MCP 这类方案要让模型自己写选择器，页面一改就点错、点空，而且无法事先验证。这里的索引只对"它刚读到的那一帧"有效。

### 2. 新鲜度是一等公民
每个决定都绑定在观测指纹上：页面变了，**拒绝执行并把新表交回来**，而不是硬点。实测百度首页：热榜自动轮换 → 第一次输入被拦下（"Nothing was executed"）→ 用新观测重选 → 成功。**任何变更都不会被自动重试**，所以不会出现"点两次""提交两遍"。

### 3. Token 便宜
不把截图喂给模型（截图只给人看），每步只送结构化文本：可见文本 + 元素表 + 本轮可选操作。

### 3b. 主 agent 不读页面
表格、索引、拒绝与重读都发生在子 agent 的上下文里，对话只收到一段结论。页面有多复杂，主 agent 的上下文就还是那么长；它也**没有**能点错页面的工具。

### 4. 模型不用猜能做什么
表里直接列出**这一帧允许的操作与目标**，包括下拉框的每一个可选项（`6:1 → Stay category → Design`）。不支持的操作、被遮挡的控件、被禁用的字段根本不会出现在表里。

### 5. 一条循环，不是两套
浏览器循环、新鲜度护栏、执行器都在 Python 引擎里，由 **21 项真实浏览器 guard 检查 + 10 项 sidecar 端到端检查 + 92 项离线单测**覆盖；插件只是薄适配层（启动 sidecar、渲染表格、转发信号）。改一处，两边一致。

### 6. Session 级隔离与回收
每个 DSH Session 一个独立浏览器（独立 profile、独立调试端口、独立 daemon），操作串行；Session 结束自动全关。多个会话并行不会互抢标签页，也不会串状态。

浏览器属于**发起任务的那个 Session**，不属于某一次委派：子 agent 来去，浏览器、登录态和标签页留下。所以连续几个 `browser_task` 是接着同一个页面继续，而不是每次重开。`mode: attach` 接来的外部浏览器**一次只留给一个 live Session**，另一个会话会被明确拒绝——两个 Session 抢同一个外部浏览器，是这层里唯一真正的数据风险。

### 7. 不碰你正在用的浏览器
插件自起一个专用 Chrome 实例。它**读不到**你个人 Chrome 的 profile（macOS 下 DSH 宿主进程访问该目录会被拒），也正因为如此，不会出现 Chrome 144+ 那个"允许远程调试"的授权弹窗，更不会把你的登录态卷进自动化。需要接自己的浏览器时，用 `mode: attach` + `cdpEndpoint` 显式指定。

每个 Session 用**自己的** profile：同一个 profile 如果已有浏览器在跑，Chrome 会把新启动"交接"给旧实例并直接退出（status 0），两个 Session 就会共用一个浏览器。因此插件按 Session 分目录；若宿主重启而浏览器还在，插件会**接管**那个实例（同一个 Session 的同一份 profile），继续用它的登录态与标签页，而不是再起一个。

一次启动只留**一个**标签页：浏览器自己会开一个启动标签页，连接层又会给这次运行一个独立标签页（命名 daemon 之间不能共用一个），运行驱动后者；页面就绪后，启动标签页会被关掉。收尾是保守的——浏览器里只剩空白页时不关，用户正在读的页面永远不关。

### 8. 调试能力在工具里，不在嘴上
`browser_console` 直接给控制台异常与失败请求；面板实时显示同一页面。观察和操作共享同一份状态，不存在"工具说的"和"实际页面"两套事实。

### 9. 零构建
host 半是普通 ESM，Web 半是手写的 `__ModuleLoader__` 脚本，没有 tsdown/rollup 步骤；克隆下来即可安装、即可改。

### 10. 能力可关
`allowScreenshots`、`allowGoalMode`、`reserveBrowserUseSlot` 都是配置项；只想要"看图 + 点点点"就把付费策略关掉。

---

## 三、安装

这个仓库里同时有插件（Node）和它的 Python 半（sidecar）。两步：

```bash
# ① Python 环境：把引擎装进本仓库自己的 .venv（引擎默认取自同级 ../jev-ultrafast）
uv sync

# ② 插件本体：装进 DSH profile
dsh plugin --profile desktop add /absolute/path/to/dsh-browser-use
```

或在 DSH 的 **Plugins** 页面里按路径安装。安装后**重启 DSH**（host 代码在进程内会被缓存，Web 端 bundle 在启动时装载）。

引擎 checkout 不在同级、或你想复用它已有的虚拟环境时，在 profile 的 `cordis.patch.yml` 里给 `id: dsh-browser-use` 那一行加配置：

```yaml
- id: dsh-browser-use
  config:
    projectPath: /absolute/path/to/jev-ultrafast   # 引擎源码位置
    # pythonPath: /absolute/path/to/python        # 或直接指定一个已经能 import jev_ultrafast 的解释器
```

## 四、引擎（必需）

sidecar（`sidecar/bridge.py`，随本仓库一起走）`import jev_ultrafast`，也就是上游那个引擎。插件按顺序**逐个试**下面这些解释器，用第一个能导入引擎的：

1. `pythonPath` 配置（**指定了就只用它**，失败不会偷偷换别的）；
2. 本仓库的 `.venv`（`uv sync` 的产物，引擎作为 path 依赖装在里边）；
3. `<projectPath>/.venv/bin/python`（引擎 checkout 自己的环境）；
4. `uv run`（`projectPath`、否则本仓库）；
5. `python3`（要求它已经能 `import jev_ultrafast`）。

`projectPath` 的取值顺序：配置 → 环境变量 `DSH_BROWSER_USE_PROJECT`（或 `JEV_ULTRAFAST_PROJECT`）→ 同级 `../jev-ultrafast`。

### 装完怎么确认"都装好了"

插件本身是纯 JavaScript，`pnpm add` 只能保证**插件**装好了；引擎是另一个生态里的 Python 包，安装器无法替它打包或安装。所以插件不假设、而是**检测**，并把结果说清楚：

**① 装完立刻自检（一条命令，退出码可用在脚本里）**

```bash
npm run doctor                     # 或 node bin/doctor.mjs [/path/to/jev-ultrafast]
```

```text
Engine   : /Users/…/dsh-browser-use/.venv/bin/python (Python 3.12.14, chosen by this package’s virtualenv (uv sync))
           jev_ultrafast 0.1.0 at /Users/…/jev-ultrafast/jev_ultrafast
           browser-harness 0.1.13
Sidecar  : /Users/…/dsh-browser-use/sidecar/bridge.py
Browser  : /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Status   : ready
```

缺什么就直接给命令；每个候选解释器都试过、失败原因逐条列出：

```text
Engine   : not usable — tried 2 interpreter(s)
           /Users/…/dsh-browser-use/.venv/bin/python (this package’s virtualenv (uv sync)): No module named 'jev_ultrafast'
           /usr/bin/python3 (system python3): No module named 'jev_ultrafast'
Problems :
  - … (pythonPath): ModuleNotFoundError: No module named 'jev_ultrafast'
    fix: install the engine: uv sync in /Users/…/dsh-browser-use (or cd ../jev-ultrafast && uv sync)
```

**② DSH 启动时就检查**

插件加载时会跑同一个探测：就绪就往日志 INFO 写一行版本；不就绪就 WARN 输出整份报告（含修复命令）。不会因为缺引擎就加载失败、把整个 profile 拖下水。

**③ 调用前再兜一次**

任何浏览器工具在启动 sidecar 之前都会确认引擎可用；不可用就**直接拒绝并附上同一份诊断**，而不是抛一个"sidecar exited (1)"。

**④ 随时问模型**

`browser_doctor` 工具返回同一份报告 + 当前 Session 的浏览器状态，可以直接问："看看浏览器环境好了没"。

## 五、配置

写入 profile 的 `cordis.patch.yml` 中 `id: dsh-browser-use` 那一行的 `config:`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `projectPath` | 空（可用环境变量） | 引擎 checkout 位置 |
| `pythonPath` | 自动 | 指定解释器（已安装引擎 wheel 时用这个） |
| `mode` | `launch` | `launch` 自起浏览器；`attach` 接已有浏览器 |
| `cdpEndpoint` | — | `attach` 模式的 DevTools WebSocket 地址 |
| `executablePath` | 系统 Chrome | 启动哪个浏览器 |
| `userDataDir` | 每 Session 一个（`~/.jev-ultrafast/browser/<session>`） | 专用 profile 目录 |
| `headless` | `false` | 无窗口启动 |
| `reserveBrowserUseSlot` | `true` | 占用 `ctx.browserUse` 单例槽（该服务被挂载时） |
| `allowGoalMode` | `false` | 开放 `browser_goal`（花 TypeSafe 额度） |
| `allowScreenshots` | `true` | 开放 `browser_screenshot` |
| `requestTimeoutMs` | `180000` | 单次 sidecar 请求上限 |
| `delegate` | `true` | 浏览器操作交给子 agent；`false` 时挂给本对话（直接模式） |
| `subagentProvider` | `spawn` | `ctx.subagents` 里的 provider 名；需要它能组合**进程内**子 agent，否则退回直接模式 |
| `maxDepth` | `0` | 子 agent 的委派深度上限；`0` 表示用 provider 自己的递归预算 |

## 六、验证（不花一分钱）

```bash
npm run check             # 全部：Python 单测 + Node 检查（真浏览器，无模型调用）
uv run pytest             # 21 项：sidecar 协议契约（离线）
uv run python test/check_bridge.py   # 10 项：sidecar 端到端（stdio + 真浏览器）
uv run python test/check_tabs.py     # 5 项：一次启动只留一个标签页
node test/plugin.mjs      # 30 项：21 工具与拒绝（真浏览器）+ 4 缺引擎诊断 + 2 attach 独占 + 3 在途取消
node test/delegation.mjs  # 18 项：对话只见 browser_task、子 agent 独享浏览器工具、跨委派复用同一浏览器、取消与回退
node test/inspector.mjs   # 14 项：Web 端注册 + host 路由 + 页面可渲染
```

引擎不在同级目录时：

```bash
DSH_BROWSER_USE_PROJECT=/path/to/jev-ultrafast node test/plugin.mjs
```

## 七、与官方 `@deepseek-ai/dsh-browser-use` 的关系

DSH 自带 `@deepseek-ai/dsh-browser-use`，那是"浏览器能力"的**服务定义**（只有一个注册槽，不含任何浏览器操作：没有 `dsh.bundle`、没有 `./client`、不注册工具）。本项目是**第三方 provider 实现**，包名 `@rc/dsh-browser-use`——scope 不同，两者不会互相覆盖。

npm 上未 scoped 的 `dsh-browser-use` 属于**另一个项目**（Browser Use Cloud 的桥接包），与本插件无关；按名安装时认 scope，别装错。

如果 profile 里挂载了那个服务，本插件会占用它唯一的 provider 槽；与 Playwright MCP / Chrome DevTools MCP / Stagehand 同时启用会冲突，此时把 `reserveBrowserUseSlot` 设为 `false` 即可只加载工具、不占槽。

（实测：桌面端 0.2.0-rc.2 的 `app.asar` 里没有任何 browser-use 包，monorepo 也没有把它挂进任何 composition——所以这条"占槽"多数情况下不会发生，插件走的是"组合里没有该服务"的分支。）

### 与 DSH provider 契约的对齐

上游那 63 行只定义**槽、名字和所有权**，契约写在 `docs/subsystems/browser-use.zh.md` 与对应的决策记录里。本插件逐条对齐：

| 契约 | 做法 |
| --- | --- |
| 单槽注册，卸载时释放 | `ctx.get('browserUse')?.register('browser-use')`，disposer 由 effect 管理 |
| 释放前先停工具、再等自有工作结束 | effect 的清理顺序：工具 → Session 浏览器 → 注册槽 |
| 浏览器属于确切的 live Agent/Session | 每次调用都核对发起者仍是 live agent；resume/fork 是新的浏览器 |
| 附加浏览器独占 | 该 provider 实例内一次只留给一个 live Session，第二个被明确拒绝（另有 2 项检查） |
| 取消是启动前后统一的通道 | 请求级 `AbortSignal`：在途请求立即结算（kind `cancelled`），委派与 `run.dispose()` 一起收尾；**已交付给浏览器的操作不回滚** |
| 清理失败不重用 | 关闭失败的代次被标记为不可用：下一次打开换新进程 + 新 daemon 名，并把原因写进工具结果 |
| 子 agent 生命周期归宿主 | 用 `ctx.subagents.start()` 启动，不自己造 Agent；`toolFilter` / 子 agent scope 都用宿主机制 |
| 工具不污染其它 agent | 浏览器工具注册在子 agent 的 scope（不是全局），子 agent 又被 `restrict({ allow: [] })` 屏蔽掉其它全局工具 |

### 内部标识仍是 `dsh-browser-use`

改的只有**包名**。这些是配置与 UI 的稳定锚点，不随包名走：

- loader 行 id：profile 的 `cordis.patch.yml` 里 `id: dsh-browser-use`，你的 `config.projectPath` 覆盖挂在这一行上；
- Web 端：tab id `dsh-browser-use/inspector`、面板路由 `/browser-use/`；
- 日志与报错前缀：`dsh-browser-use:`。

**唯一必须等于包名的是 `lib/client.js` 注册的模块 id**（`__ModuleLoader__.load({ id })`），它现在是 `@rc/dsh-browser-use`——主机侧按 Loader 行的 `name`（即包名）派发，写错会在控制台见到 `bundle … loaded without registering "…"`。

## 八、工作原理

```text
DSH host (Node)                                        ← 本仓库 lib/
  dsh-browser-use ── ctx.tools.register(browser_task, browser_doctor)     对话只看见这两个
                  ── ctx.subagents.start('spawn')                         委派子 agent
                  │     └─ 子 agent 的 scope：browser_* 只注册在这里
                  │        子 agent 被 restrict({ allow: [] }) 屏蔽其它全局工具
                  ── ctx.systemPrompt.section(子 agent 的使用规则)
                  ── ctx.webServer.register('/browser-use')     面板路由
                  └─ 每 Session 一个 sidecar 进程，操作串行（委派之间复用）
                         │  stdio JSON lines
                         ▼
  sidecar/bridge.py                                    ← 本仓库 sidecar/
      ├─ Browser.observe / Browser.act / 截图 / settle       （引擎的既有执行器）
      └─ Agent + TypeSafe 策略（仅 browser_goal 使用）
                         │  CDP
                         ▼
                   专用 Chrome 实例（每 Session 一份 profile）

引擎 = jev_ultrafast（另一个仓库），作为 Python 依赖被 sidecar import。
```
## 九、局限

- **安装不保证引擎存在**：插件装好≠引擎装好，所以它检测（见第四节）。它也不会替你去装 Python 依赖——那属于用户环境，命令交给你执行（`uv sync`）。
- 依赖 Python 引擎；引擎不可用时浏览器工具会拒绝并给出修复命令（`browser_doctor` 随时可查）。
- `browserUse` 槽独占（仅当该服务被挂载时）。
- 改了插件代码要**重启 DSH** 才生效。
- 不提供 `browser_eval` / 坐标输入——模型输出变成代码会破坏本项目的第一原则。
- 页面状态不随 Session 恢复：resume/fork 会开新浏览器（DSH provider 约定如此）。
- `browser_goal` 花的是 TypeSafe 与文本模型额度，DSH 的用量统计看不到这部分。
- **委派需要组合里有 subagent provider**（如 `@deepseek-ai/dsh-subagent-spawn-in-process`，且它能组合进程内子 agent）。没有就退回直接模式：日志 WARN、`browser_doctor` 的 `Delegation:` 行写明原因。标准 DSH base bundle 默认已挂 `spawn`；如果 provider 在插件**加载之后**才出现，要重启 DSH 才会进入委派模式。
- 子 agent 被限制成只有浏览器工具（全局工具被它的 `allow: []` 挡住）：它能点页面，不能碰你的文件与 shell。
- 委派出去的子 agent 是**一次性**的：任务结束即释放（浏览器留下）。resume 那个子会话不会带回浏览器工具——重新发一次 `browser_task` 即可。

## 十、卸载

```bash
dsh plugin --profile desktop remove @rc/dsh-browser-use
```

---

引擎：[Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT）· 浏览器接入：[Browser Harness](https://github.com/browser-use/browser-harness) · 插件宿主：[DeepSeek Harness](https://github.com/deepseek-harness)

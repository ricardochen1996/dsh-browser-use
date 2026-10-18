# 版本说明

本项目所有重要变更都记录在本文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，本项目使用[语义化版本](https://semver.org/spec/v2.0.0.html)。

0.6.2 之前的版本是从本仓库的 git 历史重建出来的（0.6.2 之前没有版本说明）：每条记录都写明它取自哪些 commit，每个发布日期就是它那个打了标签的 commit 的日期。0.6.2 是第一个边做边写下来的版本。

## [0.6.2] - 2026-10-17

### 新增

- 一条从被委派的浏览器子 agent 推回它所属对话的实时进度推送：`lib/progress.js`（`ProgressFeed`）把插件本来就记录的每一步浏览器操作（`Sessions.observed()` / `noteAction()`）变成一条两行状态消息，以子 agent 名义作为 `agent-message` 发出，于是对话可以结束本轮，而不必在 `browser_task_status` 里用 `wait: true` 阻塞着看它干活。
- 配置项 `progress`（布尔，默认 `true`）：这条推送到底推不推东西，每一步都会重新读一次；`resolveConfig` 只接受 `true` 或 `false`，所以一个“真值”的非布尔值没法悄悄把推送关掉。
- 配置项 `progressIntervalMs`（数字，默认 `30000`）：两条进度消息之间最短的间隔，按子 agent 在窗口里合并，窗口下限是 `PROGRESS_MIN_MS`（1000 ms），并保持在 `setTimeout` 能承载的范围内；窗口里的第一步立即上报，窗口内后续的步在窗口关闭时上报，而 `resolveConfig` 拒绝任何不是有限数字 `>= 0` 的值。
- `Sessions.onStep(listener)`，在每一步被记录后带着所属 Agent 调用，所以浏览器工具始终不知道有人在监听；抛错的监听器只会被记进日志，绝不会让走这一步的工具失败（连日志器也抛错，代价也只是这份上报）。
- `test/progress.mjs`：对这条推送的对抗性覆盖（导出的默认值、确切的消息文本、合并、丢弃规则、一次被拒绝的投递、间隔边界与监听器守卫，以及经由真实插件和真实浏览器的集成），并接入 `npm test` 与 `npm run check`。

### 变更

- `browser_task` 的回执和常驻子 agent 的指引现在写明：子 agent 会自己推进度——那是简短的状态消息，不需要回复，也不是它的结论；并把 `browser_task_status` 说成按需取一次的快照，其中的 `wait: true` 是最后的办法；`browser_task` 与 `browser_task_status` 的工具描述和 `wait` 参数也是同样的说法。
- `browser_task_status` 里描述"子 agent 用一条消息结束的等待"的措辞改成 `sent you a message (progress or a question)`（“给你发了一条消息：进度或提问”）：这句是给模型看的，仍是英文原文。
- 卸载插件时会释放这条推送（待处理的窗口被清掉，在途的推送被中止），`subagent/end` 会忘掉一个已结算子 agent 的状态，于是插件已不再服务的对话不会被一条过期的状态叫醒。
- `package.json`：把 `lib/progress.js` 加进发布的 `files` 列表，把 `node test/progress.mjs` 加进 `test` 与 `check` 脚本；`test/delegation.mjs` 也端到端驱动这条推送（一步一条消息，窗口内的步被合并，下一个窗口上报那次观测与在那里执行的动作）。
- `README.md` 与 `README.zh-CN.md`：工具表、委派说明、配置表和架构图都写明了这条推送、它的两行形状以及 `progress` / `progressIntervalMs` 两项。
- 随包的引擎 wheel `vendor/jev_ultrafast-0.1.0-py3-none-any.whl` 改为由 jev-ultrafast `0097710` 重新构建，`vendor/jev-ultrafast.json` 现在固定到该 revision，`uv.lock` 重新锁定这个 wheel 的哈希。

### 修复

- 插件自己持有的标签页现在按它被打开时所在的浏览器窗口布局，而不是固定成 1120x780 的模拟视口：重新随包的 wheel 带着 jev-ultrafast `0097710`，浏览器有窗口可量尺寸时就不再把自有标签页钉住，无窗口时仍给 1120x780 视口，并尊重 `JEV_VIEWPORT=WIDTHxHEIGHT`，给想要固定画面的调用方用。

_Commits: `8e3afaf`（引擎重新随包）、`f03a933`（进度推送）。本文件以及 `package.json`、`pyproject.toml`、`uv.lock` 里的 0.6.2 版本号，都在紧随其后的发版 commit 里落地。_

## [0.6.1] - 2026-10-16

### 修复

- 设置表单里的 Jev 密钥那一行现在要的就是 `jev.typesafe.apiKey` 本身——一个只写不读的密码输入框——而不再是 `jev.typesafe.apiKeyEnv`，后者那种形状会把一个手里明明拿着密钥的人粘进来的 key 拒绝掉；Host 会把 `role('secret')` 字段从每个表单响应里剥掉（所以该字段读出来永远是空的），空白草稿不写入任何东西（已存的 key 保留下来），写入被接受时回答“已写入”。`apiKeyEnv` 仍留给“宁可指名一份已存凭据”的 profile patch，但它不再是在用的表单字段，它的拒绝提示现在会说把 key 写进 `apiKey`。

_Commits: `4be75a8`（修复）、`0f57c2b`（发版）。_

## [0.6.0] - 2026-10-16

### 新增

- `jev.decider`（默认 `typesafe`，备选 `chat`）：用 `chat` 时，sidecar 由文本模型回答环路里的决策，于是 `browser_goal` 和带 intent 的 `browser_act` 都不需要 Jev key；sidecar 会为一次决策或一次目标运行在本地提供一个 chat 决策端点。

### 变更

- 插件在，Jev 就在：`jev.enabled` 现在默认 `true`，且不再是 `.volatile()` 开关，表单里唯一的 volatile 设置是 `jev.decider`（决定谁来回答，而不是 Jev 跑不跑），`typesafe.apiKey` 留空就直接花主会话路由自己的 key。
- Jev 设置表单就是一个决策者选项，加上 Jev 端点与 key 字段；它的标签、提示和拒绝文案跟随 shell 自己的 locale，而不是写死一种语言（`locale/en.json`、`locale/zh.json`）。
- `jev.textModel` 不再是表单字段，默认 `reasoning: 'thinking-disabled'`；随包的 Jev wheel 以及基准文档和配图都跟着刷新了。

_Commits: `0077f1b`（功能）、`c2c43ef`（发版）。_

## [0.5.1] - 2026-10-02

### 变更

- npm 包以 `@ricardochen1996/dsh-browser-use` 的名字发布：清单、Cordis bundle 行、客户端模块 id 和表单注册键都换成新名字，而内部标识 `dsh-browser-use`、`dsh-browser-use/inspector` 标签页 id、`/browser-use/` 路由、日志前缀和 profile 配置项保持不变。
- 两处 README 现在都说：要先移除旧的插件条目（`@weichen96/dsh-browser-use`）再添加这一个；并记下新名字下的第一个版本只能手动发布，因为 npm 的 trusted publishing 设置要等包存在之后才提供；到 0.5.0 为止的版本仍在旧 scope 下可以安装。
- 0.5.1 是第一个在新 scope 下发布的版本，也是第一个通过 `release.yml` 发布的版本；插件本身与 0.5.0 相比没有变化。

_Commits: `4c7c786`（scope 迁移）、`5a57668`（发版）。_

## [0.5.0] - 2026-10-02

### 新增

- `mode: attach` 在 profile 加载时就检查，而不是等到第一次调用浏览器：填了端点就问它的 `GET /json/version`（是 ws 地址则只问端口上有没有人在听），没填就按引擎会找到它的方式去找你正在用的浏览器，`node bin/doctor.mjs --mode attach --cdp-endpoint URL` 可以在终端里问同一个问题；这项检查只读 Chrome 已经公开的东西：不开页面，也不等任何弹窗。

### 修复

- 接不上的 attach 目标现在是一个真问题，而且用的是引擎自己的说法：修复办法随加载日志一起，在 profile 被组合的那一刻出现，`browser_doctor` 不再为一个根本不存在的浏览器报 `Status: ready`（旧警告被标成 `informational`，而 `reportText` 会把它丢掉，所以它从来没在任何地方打印过）。

_Commits: `ac6ce83`（功能）、`48c0d1f`（发版）。_

## [0.4.0] - 2026-10-02

### 变更

- 引擎环境用机器上已有的 Python 3.12+ 构建（DSH 自带的运行时、它装在自己主目录下的那份，然后是 uv 管理的解释器、Homebrew、pyenv、PATH）：`python -m venv`，再 `pip install --require-hashes --no-deps`，最后从磁盘装上本包带着的引擎 wheel；机器上没有合适的 Python 时，uv 仍是回退。
- `pillow` 故意不装：Browser Harness 声明它，是为了自己的截图与视频辅助函数，而本插件从不调用（sidecar 直接走 CDP 抓 JPEG，并让引擎以 `screenshots=False` 运行），于是第一次安装从约 5.8 MB 降到约 1.3 MB 的 wheel、几秒钟装完，而不是约 6 MB 再加一次 25 MB 的 Python 下载；既没有 Python 3.12+ 也没有 uv 的机器，会同时拿到两条能解决问题的命令。
- `vendor/requirements.txt` 由 `bin/vendor_requirements.py` 从 `uv.lock` 生成，两者一旦不一致 `release:check` 就失败，所以 `pip` 装下的和 `uv sync --frozen` 会装的完全一致；`DSH_BROWSER_USE_PYTHON` 指定用来构建的解释器，`PIP_INDEX_URL` 选择镜像，环境还会记下是谁构建的，供 `browser_doctor` 查看。

_Commits: `4aaefcf`（功能）、`1fd6e78`（发版）。_

## [0.3.0] - 2026-10-01

### 新增

- 本包把浏览器引擎一起发出去：`vendor/` 带着一个由固定 jev-ultrafast revision 构建的 wheel（revision 记在 `vendor/jev-ultrafast.json`），`pyproject.toml` 和 `uv.lock` 都从这个 wheel 解析引擎，于是在 npm 上装了插件的机器才有东西可 import（DSH 把插件的生命周期脚本拦下了，所以 `postinstall` 补不上这个缺口）。
- `lib/provision.js` 用 `uv sync --frozen` 把引擎装进插件自己的 `.venv`：插件加载时、浏览器调用先到时，或被要求时（`browser_doctor` 带 `install: true`，或 `bin/doctor.mjs --install`）；调用方会加入同一个包根下正在跑的那次安装，失败会在一分钟内被复用，并写明修复办法（缺 uv、Python 下载、代理、权限）。
- `bin/vendor_engine.py` 从一份 checkout 重建 wheel，并拿它核对清单里记的 revision，CI 现在也会 checkout 这个 revision；`release:check` 要求清单、wheel、`pyproject.toml`、`uv.lock` 与包文件互相一致，`release:pack` 会安装打出来的 tarball 里的引擎。
- 配置了 `projectPath` 或 `pythonPath` 仍然会改用另一个引擎，并关掉自动安装。

### 变更

- 文档写明：npm 11.20 创建的 trusted-publisher 配置默认不带发布权限，除非显式传入 `--allow-publish`；publisher 缺失或没有该权限，在 workflow 里只表现为 `E404 Not Found - PUT`；以及设置改好之后怎么在同一个 run 上重试。

_Commits: `0c97a6a`（功能）、`e1ef604`（文档）、`5779bcb`（发版）。_

## [0.2.0] - 2026-10-01

### 新增

- `browser_task_status`，随常驻子 agent 一起挂上：它报告子 agent 是在工作还是空闲、最近一个任务、已经跑了多久，以及它的浏览器在哪一页；带 `wait: true` 时会阻塞到子 agent 结算、或给你发消息、或用户发话、或 `timeout_ms` 过去（默认 2 分钟，最多 10 分钟）——调用被取消就停止等待；状态来自宿主的 `subagent/start`、`subagent/end`、`agent/inbox/inserted` 事件和它的 agent 注册表，不是插件自己的时钟。
- `browser_task` 的回执和指引不再读起来像一条“等着”的指令：它们说结论会自己以消息形式送到，告诉模型不要 sleep、也不要轮询，并点明 agent-team 的那两个工具（`wait_agent`、`list_agents`）看不到这个子 agent；`browser_doctor` 会显示本对话的子 agent 是否在工作。
- CI 与发版自动化：`.github/workflows/ci.yml` 用锁定版本的 Node/Python 和一个固定引擎跑真浏览器检查；`release.yml` 校验版本/标签一致性、对确切的 npm tarball 做冒烟测试、通过 OIDC trusted publishing 发布它，并把它附到一个可重跑的 GitHub Release 上，背后是 `bin/check-package.mjs`、`bin/check_release.py` 和 `test/test_release.py`；两处 README 都写了 trusted publishing 和稳定版发布步骤。

### 修复

- 第一次自动发版在发布这一步就失败了，还没到 registry 就断了：npm 把裸的 `dist/<name>.tgz` 规格当成 GitHub 简写 `github:dist/<name>.tgz`，并对它执行 `git ls-remote`；workflow 现在传 `./dist/<name>.tgz`，npm 会把它当本地文件，GitHub Release 那一步也保持同一路径（v0.2.0 标签就指向这个修复）。

_Commits: `0f994ed`（CI）、`27e8460`（功能）、`5059fd8`（发版）、`ab43d88`（修复，打标签的那个顶端提交）。_

## [0.1.0] - 2026-10-01

### 新增

- DeepSeek Harness 的浏览器插件（host 半 + Web 端半），它的 Python sidecar 每个 Session 驱动一个 Chrome，并把页面变成一张带索引的动作空间表：模型选的是一个 `(operation, target index)` 组合，永远不是 selector 或坐标；每个动作都绑定在它读自的那次观测上，并与上游 provider 契约逐条对齐（单槽 `browserUse` 注册、按 Session 归属、attach 独占、请求级取消，以及清理失败后的代次绝不复用）。
- 浏览器操作跑在一个通过 `ctx.subagents` 启动的子 agent 里：对话只拿着 `browser_task` 和 `browser_doctor`，而 `browser_*` 注册在被委派子 agent 自己的 scope 里、对其它所有 agent 不可见；每个对话一个浏览器，让接连的任务可以复用它留下的标签页与登录态。
- `cdpEndpoint` 接受一个 http(s) 的 CDP 端点，按 MCP provider 的方式校验，并在 `browser_doctor` 里打印：sidecar 把 http(s) 端点交给 `BU_CDP_URL`，把 `ws` 端点留在 `BU_CDP_WS`，不是 URL 的一律拒绝，并清掉另一个变量，免得过期的端点抢先；接上一个只有空白页的浏览器时，直接采用那个标签页，不做导航。
- `lib/config.js` 规范化 `jev` 配置块（`enabled`、`source`、`typesafe`、`textModel`），`lib/jev.js` 按次解析 TypeSafe 与文本模型的端点、模型和 key：`source: session` 时继承主会话路由，并清掉引擎的环境变量，好让 sidecar 永远看不到环境里漂着的 key。
- 开着 Jev 时，`browser_act` 接受 `intent`：不给 operation 时由 TypeSafe 在当前观测上选出操作与目标，带 intent 却不给 text 的 `TYPE_TEXT` 由 Jev 文本模型写入值；凭据与 `browser_goal` 一样按次解析，sidecar 保留一小段动作历史以免重复空操作，动作空间表会显示 checkbox/select/disclosure 的状态。
- Jev 配置组渲染在侧边栏插件表单里（开关、source、TypeSafe 与文本模型的端点和 key），改完立即生效，由 `locale/en.json` 和 `locale/zh.json` 支撑；`browser_doctor` 报告 Jev 状态和 key 来源。
- 默认 README 是英文，`README.zh-CN.md` 保留完整的中文版，各自带自己的 banner 与工作原理配图；README 里写了插件的亮点和一份实测速度对比（开 Jev 约 10.7 s，不开约 24.6–26.7 s，2.3–2.5 倍，全部经过独立校验），可复现的脚本、夹具、结果与图表生成器在 `bench/`，SVG 在 `docs/`。
- 最初的测试套件是 62 项针对真实浏览器的 Node 检查与 21 项 Python 检查（`test/plugin.mjs`、`test/delegation.mjs`、`test/inspector.mjs`、`test/check_bridge.py`、`test/test_bridge.py`）；同一版本里又补上了 Jev 对 intent、配置、设置表单和元素状态的覆盖。

### 变更

- 第一个 npm 版本，发布在当时的 `@weichen96` scope 下：新增 `LICENSE`，并把它、Python 桥和双语文档一起打进包里，修掉发版时的 lint 失败，也写明了实测基准的边界。

_Commits: `2fe1e30`、`02c5efe`、`7935a91`、`bc1e08f`、`2e6dc3b`、`f17bd43`、`dc3bd8b`、`a5494d1`、`24b9ead`、`da1b9a6`、`0028827`（发版）。_

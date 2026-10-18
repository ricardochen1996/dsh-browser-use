# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.6.2 were reconstructed from this repository's git history (there was no changelog before 0.6.2): each entry names the commits it was derived from, and every release date is the date of its tagged commit. 0.6.2 is the first release written down as it was made.

## [Unreleased]

### Added

- `attachSharing`: `exclusive` (the default) or `shared`. In `mode: attach`, `shared` withdraws the one-Session reservation, so every live Session may drive the same external browser — each through its own daemon and its own tab — instead of the second one being refused. Sharing changes nothing about letting go: closing one Session's browser closes that Session's tab and stops its daemon, never the browser the others are still using (`test/test_bridge.py` pins that down). `shared` with `mode: launch` is refused when the profile loads, because a launched browser already belongs to one Session.
- `Sessions.attachHolders`, the number of live Sessions holding the attached browser. A Session holds it from its first browser call — the reservation is taken before the engine is asked, which is what makes the refusal the second Session reads the one that matters — so this is "who holds it", not "who has a page open". `browser_doctor` prints it in attach mode (`attach sharing shared (2 live)`), so "why was my other Session refused the browser" is answered by the tool a person already calls first.
- 9 offline checks for the answers sharing can give (`test/plugin.mjs`): sharing withdraws the refusal and reaches the engine, the default stays exclusive, asking to share outside attach mode is refused, and `browser_close` says what it does not close. The exclusivity checks now cover both halves of a reservation — the second Session is refused, and closing the holder frees it for the next one (`test/plugin.mjs` `attachExclusivity`).

### Changed

- The attach refusal now names the third way out — `attachSharing "shared"` — beside waiting for the holder to close its browser and giving each Session its own browser with `mode: "launch"`.
- `browser_close` in `mode: attach` describes what it actually closes — this Session's tab and its daemon, never the attached browser — and its result says the same, instead of the launch-mode wording that promised the browser was stopped.

### Fixed

- A profile that exports `BH_RUNTIME_DIR` (or `BH_TMP_DIR`) without the engine's own `…_SHARED=1` no longer collapses every Session's daemon into one name. The plugin starts one sidecar per Session in that directory, so it now marks the directory shared for them (`lib/sidecar.js` `inheritedEnvironment`); without that, the second Session found the first Session's daemon and either one closing stopped the daemon the other was driving (5 offline checks in `test/plugin.mjs`). An explicit `…_SHARED=0` is overridden on purpose: the plugin is the caller that makes the directory shared, and a daemon an older version left at the bare `bu` name is simply no longer addressed.

## [0.6.3] - 2026-10-18

### Added

- `CHANGELOG.zh-CN.md`: the changelog in Chinese, every release from 0.1.0 to 0.6.3, translated section by section against the English file and shipped in the npm package beside the two READMEs.
- The GitHub Release body is now bilingual: this version's English section, then the Chinese one under a `**中文**` heading. The plugin market shows the release body as a plugin's update notes, so the notes it shows for this package are readable in both languages.

### Changed

- `release.yml` builds the release body from the two changelogs instead of GitHub's generated notes, which list pull requests only and left every body as one compare line (the first step of this, `34126ad`, used the English section alone); a version with no changelog section still falls back to the generated notes.
- `bin/check-package.mjs` requires `CHANGELOG.zh-CN.md` in the published tarball, and both READMEs' release steps now say to write the entry in both files.

_Commits: `34126ad` (release body from the changelog), `c60b6d4` (Chinese changelog, bilingual body), this release commit._

## [0.6.2] - 2026-10-17

### Added

- A live progress feed from the delegated browser subagent into the conversation that owns it: `lib/progress.js` (`ProgressFeed`) turns each browser step the plugin already records (`Sessions.observed()` / `noteAction()`) into a two-line status message, sent as an `agent-message` from the child, so a conversation can end its turn instead of blocking in `browser_task_status` with `wait: true` to watch the work.
- Config key `progress` (boolean, default `true`): whether the feed pushes anything at all, read again on every step; `resolveConfig` refuses anything but `true` or `false`, so a truthy non-boolean cannot turn the stream off in silence.
- Config key `progressIntervalMs` (number, default `30000`): the shortest gap between two progress messages, coalesced per child in a window floored at `PROGRESS_MIN_MS` (1000 ms) and held inside what `setTimeout` carries; the first step of a window reports at once, a step inside it is reported when the window closes, and `resolveConfig` refuses a value that is not a finite number `>= 0`.
- `Sessions.onStep(listener)`, called with the owning Agent after every recorded step, so the browser tools stay unaware that anything listens; a listener that throws is logged and never fails the tool that took the step (a logger that throws too costs only the report).
- `test/progress.mjs`: adversarial coverage of the feed (exported defaults, the exact message text, coalescing, the drop rules, a refused delivery, the interval boundaries and the listener guard, plus integration through the real plugin and a real browser), wired into `npm test` and `npm run check`.

### Changed

- The `browser_task` receipt and the persistent-subagent guidance now say the subagent reports progress on its own — short status messages that need no reply and are not its result — and describe `browser_task_status` as a snapshot on request whose `wait: true` is a last resort; the `browser_task` and `browser_task_status` tool descriptions and the `wait` parameter say the same.
- `browser_task_status` wording for a wait the subagent ended by writing: "sent you a message (progress or a question)".
- Unloading the plugin releases the feed (pending windows are cleared and pushes in flight are aborted) and `subagent/end` forgets a settled child's state, so a conversation this plugin no longer serves is not woken by a stale status.
- `package.json`: `lib/progress.js` added to the published `files` list, and `node test/progress.mjs` added to the `test` and `check` scripts; `test/delegation.mjs` also drives the feed end to end (one message for a step, a step inside the window coalesced, the next window reporting the observation and the action taken there).
- `README.md` and `README.zh-CN.md`: the tools table, the delegation notes, the configuration table and the architecture diagram document the feed, its two-line shape and the `progress` / `progressIntervalMs` keys.
- The vendored engine wheel `vendor/jev_ultrafast-0.1.0-py3-none-any.whl` was rebuilt from jev-ultrafast `0097710`, `vendor/jev-ultrafast.json` now pins that revision, and `uv.lock` re-pins the wheel hash.

### Fixed

- A tab the plugin owns is now laid out in the browser window it was opened in instead of a pinned 1120x780 emulated viewport: the re-vendored wheel carries jev-ultrafast `0097710`, which leaves an owned tab unpinned when the browser has a window to take a size from, still gives headless a 1120x780 viewport, and honours `JEV_VIEWPORT=WIDTHxHEIGHT` for a caller that wants a fixed frame.

_Commits: `8e3afaf` (engine re-vendor), `f03a933` (progress feed). This file and the 0.6.2 version stamps in `package.json`, `pyproject.toml` and `uv.lock` arrive in the release commit that follows them._

## [0.6.1] - 2026-10-16

### Fixed

- The settings form's Jev key row now asks for `jev.typesafe.apiKey` itself — one write-only password input — instead of `jev.typesafe.apiKeyEnv`, whose shape refused a key pasted by someone who had it in hand; the Host strips `role('secret')` fields from every form response (so the field always reads blank), a blank draft writes nothing (the stored key survives), and an accepted write answers "Saved". `apiKeyEnv` stays supported for a profile patch that would rather name a stored credential, but it is no longer a live form field and its refusal now says to put the key in `apiKey`.

_Commits: `4be75a8` (fix), `0f57c2b` (release)._

## [0.6.0] - 2026-10-16

### Added

- `jev.decider` (`typesafe` by default, `chat` as the alternative): with `chat` the sidecar answers the loop's decisions from the text model, so `browser_goal` and an intent-bearing `browser_act` need no Jev key; the sidecar serves a loopback chat-decision endpoint for a single decision or goal run.

### Changed

- Jev is on whenever the plugin is: `jev.enabled` now defaults to `true` and is no longer a `.volatile()` switch, the form's one volatile setting is `jev.decider` (who answers, not whether Jev runs), and an empty `typesafe.apiKey` spends the main conversation route's own key.
- The Jev settings form is a single decider choice plus the Jev endpoint and key fields, and its labels, hints and refusals follow the shell locale instead of a hard-coded language (`locale/en.json`, `locale/zh.json`).
- `jev.textModel` is no longer a form field and defaults to `reasoning: 'thinking-disabled'`; the vendored Jev wheel and the benchmark docs and illustrations were refreshed to match.

_Commits: `0077f1b` (feature), `c2c43ef` (release)._

## [0.5.1] - 2026-10-02

### Changed

- The npm package is published as `@ricardochen1996/dsh-browser-use`: the manifest, the Cordis bundle row, the client module id and the form registration keys all carry the new name, while the internal identifier `dsh-browser-use`, the `dsh-browser-use/inspector` tab id, the `/browser-use/` route, the log prefix and the profile config keys are unchanged.
- The READMEs now say to remove the old plugin entry (`@weichen96/dsh-browser-use`) before adding this one, and record that the first release under the new name had to be published by hand, because npm only offers a package's trusted-publishing settings once the package exists; releases up to 0.5.0 stay installable under the old scope.
- 0.5.1 is the first release published under the new scope and the first one released through `release.yml`; the plugin itself is unchanged from 0.5.0.

_Commits: `4c7c786` (scope move), `5a57668` (release)._

## [0.5.0] - 2026-10-02

### Added

- `mode: attach` is checked when the profile loads, not on the first browser call: a configured endpoint is asked through `GET /json/version` (a ws address whether anything is listening), the browser you browse with is asked through the engine that would find it, and `node bin/doctor.mjs --mode attach --cdp-endpoint URL` asks the same question from a terminal; the check reads only what Chrome already published, opening no page and waiting for no prompt.

### Fixed

- An unreachable attach target is now a real problem in the engine's own words: the fix travels in the load log at the moment the profile is composed and `browser_doctor` no longer reports `Status: ready` for a browser that is absent (the old warning was marked `informational`, which `reportText` drops, so it never printed anywhere).

_Commits: `ac6ce83` (feature), `48c0d1f` (release)._

## [0.4.0] - 2026-10-02

### Changed

- The engine environment is built with a Python 3.12+ the machine already has (the runtime DSH ships and the copy it installs under its home, then uv's installations, Homebrew, pyenv, PATH): `python -m venv`, then `pip install --require-hashes --no-deps`, then the engine wheel this package carries from disk; uv stays as the fallback for a machine with no suitable Python.
- `pillow` is left out of the install because Browser Harness declares it for screenshot and video helpers this plugin never calls (the sidecar captures its JPEGs over CDP and runs the engine with `screenshots=False`), taking a first install from about 5.8 MB to about 1.3 MB of wheels in a few seconds instead of about 6 MB plus a 25 MB Python download; a machine with neither Python 3.12+ nor uv is told both commands that fix it.
- `vendor/requirements.txt` is rendered from `uv.lock` by `bin/vendor_requirements.py`, and `release:check` fails when the two drift apart, so `pip` installs exactly what `uv sync --frozen` would; `DSH_BROWSER_USE_PYTHON` pins the interpreter to build with, `PIP_INDEX_URL` selects a mirror, and the environment records what built it for `browser_doctor`.

_Commits: `4aaefcf` (feature), `1fd6e78` (release)._

## [0.3.0] - 2026-10-01

### Added

- The package ships the browser engine: `vendor/` carries a wheel built from a pinned jev-ultrafast revision (named by `vendor/jev-ultrafast.json`), and `pyproject.toml` and `uv.lock` resolve the engine from it, so a machine that installed the plugin from npm has something to import (DSH gates plugin lifecycle scripts off, so a `postinstall` could not have filled the gap).
- `lib/provision.js` installs the engine with `uv sync --frozen` into the plugin's own `.venv` when the plugin loads, when a browser call arrives first, or on request (`browser_doctor` with `install: true`, or `bin/doctor.mjs --install`); callers join the one install running for a package root, and a failure is reused for a minute and names its fix (missing uv, Python download, proxy, permissions).
- `bin/vendor_engine.py` rebuilds the wheel from a checkout and checks it against the manifest's revision, which CI now checks out; `release:check` requires the manifest, wheel, `pyproject.toml`, `uv.lock` and package files to agree, and `release:pack` installs the packed tarball's engine.
- A configured `projectPath` or `pythonPath` still selects another engine and turns the install off.

### Changed

- Documented that npm 11.20 creates trusted-publisher configurations without publish permission unless `--allow-publish` is passed, that a publisher missing or lacking that permission surfaces in the workflow only as `E404 Not Found - PUT`, and how to retry the same run once the setting is fixed.

_Commits: `0c97a6a` (feature), `e1ef604` (docs), `5779bcb` (release)._

## [0.2.0] - 2026-10-01

### Added

- `browser_task_status`, mounted with a persistent subagent: it reports whether the subagent is working or idle, its latest task, how long it has run and the page its browser is on, and with `wait: true` it blocks until the subagent settles or messages the conversation, the user writes, or `timeout_ms` passes (default 2 min, at most 10) — a cancelled call stops waiting; the state comes from the host's `subagent/start`, `subagent/end` and `agent/inbox/inserted` events and its agent registry, not from a clock of the plugin's own.
- The `browser_task` receipt and guidance no longer read as an instruction to wait: they say the report arrives as a message on its own, tell the model not to sleep or poll, and name the agent-team tools (`wait_agent`, `list_agents`) that cannot see the subagent; `browser_doctor` shows whether this conversation's subagent is working.
- CI and release automation: `.github/workflows/ci.yml` runs locked Node/Python and real-browser checks with a pinned engine, and `release.yml` verifies version/tag consistency, smoke-tests the exact npm tarball, publishes it through OIDC trusted publishing and attaches it to a rerunnable GitHub Release, backed by `bin/check-package.mjs`, `bin/check_release.py` and `test/test_release.py`; both READMEs document trusted publishing and the stable release steps.

### Fixed

- The first automated release failed in the publish step, before anything reached the registry, because npm resolved the bare `dist/<name>.tgz` spec as the GitHub shorthand `github:dist/<name>.tgz` and ran `git ls-remote` against it; the workflow now passes `./dist/<name>.tgz`, which npm treats as a local file, and the GitHub Release step keeps the same path (the v0.2.0 tag points at this fix).

_Commits: `0f994ed` (CI), `27e8460` (feature), `5059fd8` (release), `ab43d88` (fix, the tagged tip)._

## [0.1.0] - 2026-10-01

### Added

- The DeepSeek Harness browser plugin (host half plus Web half) whose Python sidecar drives one Chrome per Session and turns the page into an indexed action space: the model picks an `(operation, target index)` pair, never a selector or a coordinate, and every action is bound to the observation it was read from, aligned with the upstream provider contract (single-slot `browserUse` registration, per-Session ownership, exclusive attach, request-level cancellation, and a generation never reused after a failed cleanup).
- Browser work runs in a child agent started through `ctx.subagents`: the conversation holds `browser_task` and `browser_doctor` only, while `browser_*` is registered in the delegated child's own scope and hidden from every other agent, and one browser per conversation lets tasks reuse its tabs and logins.
- `cdpEndpoint` takes an http(s) CDP endpoint, validated the way the MCP providers do and printed in `browser_doctor`: the sidecar routes an http(s) endpoint to `BU_CDP_URL`, keeps a `ws` endpoint on `BU_CDP_WS`, refuses anything that is not a URL, and clears the other variable so a stale endpoint cannot win; attaching to a browser whose only page is blank adopts that tab without navigating.
- `lib/config.js` normalizes the `jev` block (`enabled`, `source`, `typesafe`, `textModel`), and `lib/jev.js` resolves the TypeSafe and text-model endpoint, model and key per call, inheriting the main conversation route when `source: session` and scrubbing engine env vars so the sidecar never sees ambient keys.
- With Jev on, `browser_act` accepts an `intent`: with no operation, TypeSafe chooses the operation and target on the current observation, and a `TYPE_TEXT` with an intent and no text gets its value from the Jev text model; credentials resolve per call like `browser_goal`, the sidecar keeps a short action history to avoid repeating no-ops, and the action-space table shows checkbox/select/disclosure state.
- The Jev configuration group renders in the sidebar plugin form (enable, source, TypeSafe and text-model endpoints and keys) with immediate effect, backed by `locale/en.json` and `locale/zh.json`; `browser_doctor` reports Jev status and key source.
- The default README is English and `README.zh-CN.md` keeps the full Chinese version, each with its own banner and how-it-works art; the READMEs document the plugin's highlights and a measured speed comparison (about 10.7 s with Jev against about 24.6–26.7 s without, 2.3–2.5x, all independently verified), with the reproducible script, fixture, results and chart generator in `bench/` and the SVGs in `docs/`.
- The initial test suite is 62 Node checks against a real browser and 21 Python checks (`test/plugin.mjs`, `test/delegation.mjs`, `test/inspector.mjs`, `test/check_bridge.py`, `test/test_bridge.py`); it is extended in the same release with Jev coverage of intent, config, the settings form and element state.

### Changed

- First npm release, published under the `@weichen96` scope of the time: adds `LICENSE` and includes it, the Python bridge and the bilingual docs in the package, fixes release lint failures, and documents the measured benchmark's boundaries.

_Commits: `2fe1e30`, `02c5efe`, `7935a91`, `bc1e08f`, `2e6dc3b`, `f17bd43`, `dc3bd8b`, `a5494d1`, `24b9ead`, `da1b9a6`, `0028827` (release)._

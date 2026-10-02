/**
 * Installing the engine this plugin drives: one environment the package owns, built by whatever the
 * machine already has.
 *
 * DSH installs plugins with pnpm, which runs no install script the user has not approved, so the
 * environment is built here instead: by the first caller that finds the engine missing, once, while
 * every other caller that needs it waits for that same install.
 *
 * There are two ways to build it, and the cheap one comes first:
 *
 * 1. **`python`** — a Python 3.12+ that is already on the machine (DSH ships one inside the
 *    application, and installs a copy under its home) builds a virtualenv, `pip` installs
 *    `vendor/requirements.txt` by version and by hash, and the engine wheel this package carries is
 *    installed from disk. Nothing else is downloaded: about 1.3 MB of wheels, a few seconds, and no
 *    tool the user has to install first.
 * 2. **`uv`** — for a machine with uv and no suitable Python, `uv sync --frozen` builds the same
 *    environment from `uv.lock`, fetching Python 3.12 if it has to.
 *
 * uv itself is never installed from here: a plugin that downloads and runs an installer on its own
 * is a plugin no one can audit. A machine with neither a Python 3.12+ nor uv is reported with the
 * command that fixes it, and the doctor names every interpreter it tried.
 *
 * @module dsh-browser-use/provision
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PYTHON_MINIMUM,
  environmentPython,
  findBasePython,
  pipArguments,
  pipEnvironment,
  pipIndex,
  runCommand,
  venvArguments,
  venvEnvironment,
  wheelArguments,
} from './python.js'

export { PYTHON_MINIMUM, environmentPython } from './python.js'

/** This package's own root: the sidecar, the bundled engine, and the environment built from them. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The Python uv is asked for when uv builds the environment; the version CI runs. */
export const PYTHON_VERSION = '3.12'

/** How long one install may take; the first one downloads the locked wheels and, with uv, Python. */
export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/** A failed install is not repeated by every browser call that finds the engine missing meanwhile. */
const RETRY_AFTER_MS = 60 * 1000

/** Failures a user fixes by installing something: retried at once, never answered from the window. */
const IMMEDIATE = new Set(['no_python', 'no_uv'])

const KEPT_LINES = 40

/** Package root -> its install: the one running now, or the last one to finish. */
const installs = new Map()

/** The environment this package builds for itself. */
export function ownEnvironment(root = PACKAGE_ROOT) {
  return join(root, '.venv')
}

/** Where the install records what it built the environment with, so the doctor can say it later. */
export function environmentRecordPath(environment) {
  return join(environment, '.dsh-browser-use.json')
}

/** What built the environment, or `undefined` when this package did not build it. */
export function environmentRecord(environment) {
  try {
    return JSON.parse(readFileSync(environmentRecordPath(environment), 'utf8'))
  } catch {
    return undefined
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Where uv is looked for after PATH: its own installer's directories, then Homebrew's. */
function uvDirectories(env) {
  const home = homedir()
  return [
    env.UV_INSTALL_DIR,
    env.UV_INSTALL_DIR && join(env.UV_INSTALL_DIR, 'bin'),
    env.XDG_BIN_HOME,
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ].filter(Boolean)
}

/**
 * The uv binary, wherever its installers put it.
 *
 * DSH started from a macOS app has a minimal PATH, so the directories uv's installer and Homebrew
 * use are searched after PATH. `UV` — which uv sets for the processes it runs — names one exactly,
 * and a `UV` that names nothing is reported rather than passed over.
 */
export function findUv(env = process.env) {
  if (env.UV) return isFile(env.UV) ? env.UV : undefined
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv'
  for (const directory of [...String(env.PATH ?? '').split(delimiter), ...uvDirectories(env)]) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/** The bundled engine as `vendor/jev-ultrafast.json` names it, with the wheel's absolute path. */
export function bundledEngine(root = PACKAGE_ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'jev-ultrafast.json'), 'utf8'))
    return { ...manifest, path: join(root, 'vendor', manifest.wheel) }
  } catch {
    return undefined
  }
}

/**
 * The uv install, exactly as it runs: the locked dependencies, without the dev group, into
 * `environment`.
 *
 * `--inexact` leaves alone anything else in that environment, such as the dev tools of a checkout;
 * `--no-install-project` installs what the sidecar imports without building the sidecar itself;
 * `--no-install-package pillow` leaves out the one dependency this plugin never calls (see
 * `bin/vendor_requirements.py`), which is the difference between a 5.8 MB and a 1.3 MB first install.
 */
export function installArguments(root = PACKAGE_ROOT) {
  return [
    'sync', '--frozen', '--no-dev', '--no-install-project', '--inexact',
    '--no-install-package', 'pillow',
    '--python', PYTHON_VERSION,
    '--project', root,
  ]
}

/** How to ask for the install, from the model's side and from a shell. */
export function installHint(root = PACKAGE_ROOT) {
  return `browser_doctor with install: true, or node ${join(root, 'bin', 'doctor.mjs')} --install`
}

/** How to ask for the install again. */
export function retryText(root = PACKAGE_ROOT) {
  return `retry: ${installHint(root)}`
}

/** A duration as a person reads it: `42s`, `3m 5s`. */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60 === 0 ? '' : ` ${seconds % 60}s`}`
}

function networkFix(root) {
  return `check the network: a proxy goes in HTTPS_PROXY in the environment DSH runs in; then ${retryText(root)}`
}

const UV_INSTALLER = process.platform === 'win32'
  ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  : 'curl -LsSf https://astral.sh/uv/install.sh | sh (or brew install uv)'

const PYTHON_INSTALLER = process.platform === 'win32'
  ? 'winget install Python.Python.3.12'
  : process.platform === 'darwin'
    ? 'brew install python@3.12'
    : 'your distribution\u2019s python3.12 package (apt install python3.12 python3.12-venv)'

/** The diagnosis, shortened: the first error line, the first cause, and the last one. */
export function summarize(lines) {
  const clipped = text => (text.length > 160 ? `${text.slice(0, 159)}…` : text)
  const pip = lines.filter(line => /^ERROR:/u.test(line.trim())).map(line => line.trim())
  if (pip.length > 0) return [...new Set(pip.slice(-2))].map(clipped).join(' — ')
  const start = lines.findIndex(line => /^error:/iu.test(line))
  if (start === -1) return lines.map(line => line.trim()).filter(Boolean).at(-1) ?? ''
  const causes = []
  for (const line of lines.slice(start + 1)) {
    const cause = line.match(/^\s+(?:cause|caused by):\s*(.*)$/iu)
    if (cause) causes.push(cause[1].trim())
    else if (line.trim() !== '') break
  }
  const parts = [lines[start].replace(/^error:\s*/iu, '').trim(), causes[0], causes.at(-1)].filter(Boolean)
  return [...new Set(parts)].map(clipped).join(' — ')
}

/** The fix for a failed install, decided by what the installer said. */
export function fixFor(output, root = PACKAGE_ROOT) {
  const retry = retryText(root)
  if (/No matching distribution found|Could not find a version that satisfies/iu.test(output)) {
    return `the index pip read (${pipIndex()}) does not carry the locked versions: check the network, or set `
      + `PIP_INDEX_URL in the environment DSH runs in to a mirror of PyPI; then ${retry}`
  }
  if (/THESE PACKAGES DO NOT MATCH THE HASHES|Expected sha256|hash mismatch/iu.test(output)) {
    return `an index served an artifact that is not the one uv.lock records: point PIP_INDEX_URL at a mirror of `
      + `PyPI (or at PyPI itself); then ${retry}`
  }
  if (/No module named pip|ensurepip is not available|venv is not available/iu.test(output)) {
    return `that Python cannot build a virtualenv with pip: install your distribution's venv package `
      + `(for example python3.12-venv), or set config.pythonPath to an interpreter that already imports jev_ultrafast`
  }
  if (/cpython-|python-build-standalone|No interpreter found for Python|No download found|Python downloads are set/iu.test(output)) {
    return `uv could not get Python ${PYTHON_VERSION}: install it yourself (uv python install ${PYTHON_VERSION}, or your system's package), `
      + `or set UV_PYTHON_INSTALL_MIRROR in the environment DSH runs in to a mirror of python-build-standalone; then ${retry}`
  }
  if (/incompatible with the project's Python requirement/iu.test(output)) {
    return `install Python ${PYTHON_VERSION} (uv python install ${PYTHON_VERSION}); then ${retry}`
  }
  if (/permission denied|read-only file system|operation not permitted|os error (?:1|13|30)\)/iu.test(output)) {
    return `${root} has to be writable by the user DSH runs as; or set config.pythonPath to an interpreter that already imports jev_ultrafast`
  }
  if (/unsupported (?:lock|schema)|failed to parse `?uv\.lock|unknown field|lockfile version/iu.test(output)) {
    return `this uv is older than the lock it has to read: update it (uv self update, or brew upgrade uv); then ${retry}`
  }
  if (/files\.pythonhosted\.org|pypi\.org|error sending request|tcp connect|dns error|connection (?:refused|reset)|timed out|tunnel error|certificate|network/iu.test(output)) {
    return networkFix(root)
  }
  return `fix what the installer reported; then ${retry}`
}

/** One install's state, copied so no caller can change the record. */
function snapshot(status) {
  return { ...status, output: [...status.output] }
}

/** DSH's environment, minus what would make uv build some other environment, or refuse `--frozen`. */
function installEnvironment(environment) {
  const env = { ...process.env, UV_PROJECT_ENVIRONMENT: environment, NO_COLOR: '1' }
  delete env.VIRTUAL_ENV
  delete env.UV_LOCKED
  return env
}

/**
 * Where the install of one package root stands, or `undefined` when none was asked for.
 * @returns `{ state: 'installing' | 'installed' | 'failed', code, root, environment, strategy,
 *   python, pythonVersion, uv, command, startedAt, finishedAt, step, output, error, fix }`;
 *   `strategy` is `python` or `uv`, and `code` names a failure: `no_python`, `no_uv`, `no_wheel`,
 *   `python_failed`, `uv_failed`, `timeout`, or `spawn_failed`.
 */
export function installStatus(root = PACKAGE_ROOT) {
  const record = installs.get(resolve(root))
  return record === undefined ? undefined : snapshot(record.status)
}

/** What the engine's own report says when no interpreter could be used at all. */
function noPythonFailure(attempts, root, env = process.env) {
  const tried = attempts.length === 0
    ? 'no Python 3.12+ was found in DSH\u2019s runtime, uv\u2019s installations, Homebrew, pyenv, or on PATH'
    : `no usable Python 3.12+ was found:\n    ${attempts.map(item => `${item.command} (${item.source}): ${item.failure}`).join('\n    ')}`
  const uv = env.UV ? `UV names ${env.UV}, which is not a file` : 'uv is not installed either'
  return {
    code: 'no_python',
    error: `${tried}, and ${uv}`,
    fix: `install Python ${PYTHON_MINIMUM}+ (${PYTHON_INSTALLER}), or uv (${UV_INSTALLER}); then ${retryText(root)}`,
  }
}

/** Record what built the environment, for a doctor that runs after this process is gone. */
function writeRecord(environment, record) {
  try {
    writeFileSync(environmentRecordPath(environment), `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // The record is a convenience for the doctor; an environment that works without it is still built.
  }
}

/** Build the environment with a Python the machine already has: virtualenv, wheels, engine wheel. */
async function installWithPython(context) {
  const { root, environment, python, status, line, finish, budget } = context
  const wheel = bundledEngine(root)
  if (wheel === undefined || !isFile(wheel.path)) {
    return finish('failed', {
      code: 'no_wheel',
      error: `the engine wheel this package carries is missing: ${wheel?.path ?? join(root, 'vendor')}`,
      fix: 'reinstall the plugin: its Python half ships beside lib/',
    })
  }
  const base = python.interpreter.command
  status.strategy = 'python'
  status.python = base
  status.pythonVersion = python.report.python
  const env = pipEnvironment(environment)
  const interpreter = environmentPython(environment)
  const steps = [
    { command: base, args: venvArguments(environment, { clear: existsSync(environment) }),
      environment: venvEnvironment(),
      what: `creating ${environment} with ${base} (Python ${python.report.python})` },
    { command: interpreter, args: pipArguments(root, process.env), environment: env,
      what: 'installing the locked dependencies' },
    { command: interpreter, args: wheelArguments(wheel.path), environment: env,
      what: `installing ${wheel.wheel}` },
  ]
  for (const step of steps) {
    status.command = `${step.command} ${step.args.join(' ')}`
    status.step = step.what
    const result = await runCommand(step.command, step.args, {
      cwd: root, env: step.environment, onLine: line, timeoutMs: Math.max(1, budget()),
    })
    if (result.timedOut) {
      return finish('failed', {
        code: 'timeout',
        error: `${step.what} did not finish within ${duration(Date.now() - status.startedAt)} (last: ${status.step})`,
        fix: networkFix(root),
      })
    }
    if (result.spawnError !== undefined) {
      return finish('failed', {
        code: 'spawn_failed',
        error: `${step.command} could not be started: ${result.spawnError}`,
        fix: `check ${step.command}; then ${retryText(root)}`,
      })
    }
    if (result.code !== 0) {
      return finish('failed', {
        code: 'python_failed',
        error: summarize(status.output) || `${step.command} exited with ${result.code ?? result.signal}`,
        fix: fixFor(status.output.join('\n'), root),
      })
    }
  }
  writeRecord(environment, {
    strategy: 'python',
    python: base,
    version: python.report.python,
    engine: wheel.version,
    wheel: wheel.wheel,
    installedAt: new Date().toISOString(),
  })
  return finish('installed')
}

/** Build the environment with uv, from the lock, exactly as this plugin has always done it. */
async function installWithUv(context) {
  const { root, environment, uv, status, line, finish, budget } = context
  status.strategy = 'uv'
  status.uv = uv
  const args = installArguments(root)
  status.command = `${uv} ${args.join(' ')}`
  status.step = 'running uv sync'
  const result = await runCommand(uv, args, {
    cwd: root, env: installEnvironment(environment), onLine: line, timeoutMs: Math.max(1, budget()),
  })
  if (result.timedOut) {
    return finish('failed', {
      code: 'timeout',
      error: `uv sync did not finish within ${duration(Date.now() - status.startedAt)} (last: ${status.step})`,
      fix: networkFix(root),
    })
  }
  if (result.spawnError !== undefined) {
    return finish('failed', {
      code: 'spawn_failed',
      error: `${uv} could not be started: ${result.spawnError}`,
      fix: `check ${uv}; then ${retryText(root)}`,
    })
  }
  if (result.code !== 0) {
    return finish('failed', {
      code: 'uv_failed',
      error: summarize(status.output) || `uv sync exited with ${result.code ?? result.signal}`,
      fix: fixFor(status.output.join('\n'), root),
    })
  }
  writeRecord(environment, { strategy: 'uv', uv, installedAt: new Date().toISOString() })
  return finish('installed')
}

/**
 * Build the environment, or join the install already building it.
 *
 * A failed install answers again for a minute without running anything, so a burst of browser calls
 * does not become a burst of downloads; `force` — the user asking for it — runs it at once, and a
 * failure the user can fix by installing something is looked for again on every call.
 * @param options - `root`, `environment`, `force`, `timeoutMs`, and `onOutput`, which receives
 *   every line the installer prints from now until this install ends.
 * @returns the install's final status; it never rejects.
 */
export function installEngine(options = {}) {
  const root = resolve(options.root ?? PACKAGE_ROOT)
  const environment = options.environment ?? ownEnvironment(root)
  const current = installs.get(root)
  if (current?.status.state === 'installing') {
    if (options.onOutput) current.listeners.add(options.onOutput)
    return current.promise
  }
  if (options.force !== true && current?.status.state === 'failed' && !IMMEDIATE.has(current.status.code)
      && Date.now() - current.status.finishedAt < RETRY_AFTER_MS) {
    return Promise.resolve(snapshot(current.status))
  }

  const status = {
    state: 'installing',
    code: undefined,
    root,
    environment,
    strategy: undefined,
    python: undefined,
    pythonVersion: undefined,
    pythonAttempts: [],
    uv: undefined,
    command: undefined,
    startedAt: Date.now(),
    finishedAt: undefined,
    step: 'looking for an interpreter',
    output: [],
    error: undefined,
    fix: undefined,
  }
  const record = { status, listeners: new Set(options.onOutput ? [options.onOutput] : []) }
  installs.set(root, record)
  const line = text => {
    status.output.push(text)
    if (status.output.length > KEPT_LINES) status.output.shift()
    if (text.trim() !== '') status.step = text.trim()
    for (const listener of record.listeners) {
      try {
        listener(text)
      } catch {
        // A listener that throws is its own problem; the install goes on for everyone else.
      }
    }
  }
  const finish = (state, failure = {}) => {
    Object.assign(status, { state, finishedAt: Date.now(), ...failure })
    record.listeners.clear()
    return snapshot(status)
  }
  const budget = () => (options.timeoutMs ?? INSTALL_TIMEOUT_MS) - (Date.now() - status.startedAt)
  const context = { root, environment, status, line, finish, budget }

  record.promise = (async () => {
    const python = await findBasePython()
    context.python = python
    status.pythonAttempts = python.attempts
    if (python.interpreter !== undefined) return installWithPython(context)
    const uv = findUv()
    if (uv !== undefined) {
      context.uv = uv
      return installWithUv(context)
    }
    return finish('failed', noPythonFailure(python.attempts, root))
  })().catch(error => finish('failed', {
    code: 'spawn_failed',
    error: `the install itself failed: ${error?.message ?? String(error)}`,
    fix: `report this; then ${retryText(root)}`,
  }))
  return record.promise
}

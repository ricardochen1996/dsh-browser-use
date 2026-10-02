/**
 * Building the sidecar's environment from a Python the machine already has.
 *
 * `uv sync` is one way to turn `uv.lock` into an environment; it is not the only one, and it is the
 * one that needs a tool the user may not have and a Python download they may not need. Any Python
 * 3.12+ can build the same environment from `vendor/requirements.txt`, which `pip` installs by
 * version and by hash, and from the engine wheel this package ships: no uv, no CPython download, no
 * project build, about 1.3 MB over the network instead of about 31 MB.
 *
 * DSH already ships a Python 3.12 runtime (the one its document tools use), so on a normal desktop
 * install that interpreter is found here and the whole first install is a few seconds. The
 * interpreters this module will use are deliberately few, and every one is **probed**: a Python that
 * cannot answer, is older than 3.12, or has no `venv`/`ensurepip` is reported rather than used.
 *
 * @module dsh-browser-use/python
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** The oldest Python the sidecar and the engine it drives run on; both declare `>=3.12`. */
export const PYTHON_MINIMUM = '3.12'

const MINIMUM = [3, 12]

/** How long one interpreter has to answer the probe before it is passed over. */
export const PROBE_TIMEOUT_MS = 20000

/** How long `python -m venv` may take when the caller names no budget. */
export const VENV_TIMEOUT_MS = 120000

/** The interpreter inside a virtualenv. */
export function environmentPython(environment) {
  return process.platform === 'win32'
    ? join(environment, 'Scripts', 'python.exe')
    : join(environment, 'bin', 'python')
}

/** Where a Python installation keeps its interpreter, relative to its root. */
function interpreterIn(root, name = process.platform === 'win32' ? 'python.exe' : 'python3') {
  return process.platform === 'win32' ? join(root, name) : join(root, 'bin', name)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The directories directly inside `path`, or none when it does not exist. */
function directories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => join(path, entry.name))
  } catch {
    return []
  }
}

/**
 * The primary-runtime payloads this DSH process can see.
 *
 * DSH's document tools run on the Python inside one of these, and the application carries a copy:
 * `process.resourcesPath` is the application's resource directory, and the desktop host is started
 * with the payload directory as an argument (its position has moved between versions, so every
 * argument is checked for the shape rather than one index being trusted). The writable copy DSH
 * installs under its home is found by `baseInterpreters` itself.
 */
export function dshPayloads() {
  const payloads = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    payloads.push(join(resources, 'runtime', 'primary-runtime'))
  }
  for (const argument of process.argv.slice(2)) {
    if (typeof argument === 'string' && argument !== '' && existsSync(join(argument, 'dependencies', 'python'))) {
      payloads.push(argument)
    }
  }
  return payloads
}

/**
 * Every interpreter worth building the environment on, best first, each with the reason it is here.
 *
 * DSH's own runtime comes first: it is the Python this machine was set up to have, and the only one
 * whose presence is a property of DSH rather than of the user's shell — on a desktop install it is
 * always there, inside the application, so the first install downloads wheels and nothing else.
 * Then uv's managed installations, then the places Homebrew, pyenv and the user's own installers
 * put a Python.
 *
 * `/usr/bin/python3` is skipped on macOS: without the developer tools it is a stub that opens an
 * installer dialog instead of printing a version, and a plugin has no business doing that. Every
 * other candidate is probed, so a stale shim costs one failed probe and nothing else.
 */
export function baseInterpreters(env = process.env) {
  const home = homedir()
  const candidates = []
  const add = (command, source) => {
    if (!command || !isFile(command)) return
    const key = real(command)
    if (candidates.some(item => real(item.command) === key)) return
    candidates.push({ command, source })
  }
  // An interpreter named outright is the only one considered — the same rule `UV` follows for uv.
  // It is how a user pins the Python this plugin builds with, and how the tests choose a strategy.
  const explicit = String(env.DSH_BROWSER_USE_PYTHON ?? '').trim()
  if (explicit !== '') return [{ command: explicit, source: 'DSH_BROWSER_USE_PYTHON' }]
  const versions = ['3.12', '3.13', '3.14', '3.15']
  const named = version => (process.platform === 'win32' ? `python${version}.exe` : `python${version}`)
  const dshHome = env.DSH_HOME || join(home, '.dsh')
  for (const runtime of directories(join(dshHome, 'dsh-runtimes')).sort()) {
    add(interpreterIn(join(runtime, 'dependencies', 'python')), 'the Python runtime DSH installed')
  }
  for (const payload of dshPayloads()) {
    add(interpreterIn(join(payload, 'dependencies', 'python')), 'the Python runtime DSH ships')
  }
  const uvPython = env.UV_PYTHON_INSTALL_DIR
    || (process.platform === 'win32'
      ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'uv', 'python')
      : join(home, '.local', 'share', 'uv', 'python'))
  for (const installation of directories(uvPython).sort().reverse()) {
    add(interpreterIn(installation), 'a Python uv installed')
  }
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin')]) {
    for (const version of versions) add(join(directory, named(version)), 'a Python on this machine')
    add(interpreterIn(directory), 'a Python on this machine')
  }
  for (const installation of directories(join(home, '.pyenv', 'versions')).sort().reverse()) {
    add(interpreterIn(installation), 'a Python pyenv installed')
  }
  for (const directory of String(env.PATH ?? '').split(delimiter)) {
    if (!directory || (process.platform === 'darwin' && real(directory) === '/usr/bin')) continue
    for (const version of versions) add(join(directory, named(version)), 'a Python on PATH')
    add(interpreterIn(directory), 'a Python on PATH')
  }
  return candidates
}

/**
 * What the probe asks an interpreter to report. `venv` and `ensurepip` are what building the
 * environment needs; `pillow` is only reported, because this plugin never imports it.
 */
const PROBE = [
  '-c',
  [
    'import json, sys',
    'answer = {"python": ".".join(str(part) for part in sys.version_info[:3]),',
    '          "executable": sys.executable, "major": sys.version_info[0], "minor": sys.version_info[1]}',
    'try:',
    '    import ensurepip, venv',
    '    answer["venv"] = True',
    'except Exception as error:',
    '    answer["venv"] = False',
    '    answer["why"] = f"{type(error).__name__}: {error}"',
    'try:',
    '    import PIL',
    '    answer["pillow"] = getattr(PIL, "__version__", "unknown")',
    'except Exception:',
    '    answer["pillow"] = None',
    'json.dump(answer, sys.stdout)',
  ].join('\n'),
]

/**
 * Ask one interpreter what it is and what it can do.
 * @returns `{ report }` when it answered, `{ failure }` with the reason it cannot be used otherwise.
 */
export function probePython(interpreter, options = {}) {
  if (!isFile(interpreter.command)) return Promise.resolve({ failure: 'does not exist' })
  return new Promise(resolve => {
    let child
    try {
      child = spawn(interpreter.command, PROBE, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ failure: `${interpreter.command} could not be started: ${error.message}` })
      return
    }
    let out = ''
    let err = ''
    const budget = options.timeoutMs ?? PROBE_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ failure: `did not answer within ${Math.round(budget / 1000)}s` })
    }, budget)
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ failure: `${interpreter.command} could not be started: ${error.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = err.trim().split('\n').filter(Boolean).at(-1) ?? `exit status ${code}`
        return resolve({ failure: detail })
      }
      let report
      try {
        report = JSON.parse(out)
      } catch {
        return resolve({ failure: `answered something unreadable: ${out.slice(0, 120)}` })
      }
      if (report.major < MINIMUM[0] || (report.major === MINIMUM[0] && report.minor < MINIMUM[1])) {
        return resolve({ failure: `Python ${report.python} is older than ${PYTHON_MINIMUM}` })
      }
      if (report.venv !== true) {
        return resolve({
          failure: `Python ${report.python} cannot build a virtual environment (${report.why ?? 'venv or ensurepip is missing'})`,
        })
      }
      resolve({ report })
    })
  })
}

/** The interpreters already found to be usable, so one install does not probe the machine twice. */
const usable = new Map()

/**
 * The first interpreter that can build the environment, with everything that was tried before it.
 *
 * Only a success is remembered: a Python the user installs a moment later has to be found by the
 * next call, while a machine that answered once does not answer again on every browser call.
 * @returns `{ interpreter, report, attempts }`; `interpreter` is `undefined` when none can be used.
 */
export async function findBasePython(env = process.env) {
  const candidates = baseInterpreters(env)
  const key = candidates.map(item => real(item.command)).join('\u0000')
  const remembered = usable.get(key)
  if (remembered !== undefined) return { ...remembered, attempts: [] }
  const attempts = []
  for (const candidate of candidates) {
    const result = await probePython(candidate)
    if (result.report === undefined) {
      attempts.push({ ...candidate, failure: result.failure })
      continue
    }
    const found = { interpreter: { ...candidate, report: result.report }, report: result.report }
    usable.set(key, found)
    return { ...found, attempts }
  }
  return { interpreter: undefined, attempts }
}

/** Drop the remembered interpreters, so the next check probes the machine again. */
export function forgetPython() {
  usable.clear()
}

/**
 * One command, its output as lines, and its exit.
 *
 * `timeoutMs` is the whole budget this command has: the child is asked to stop, then killed. The
 * caller decides what a failure means; this only reports what happened.
 * @returns `{ code, signal, timedOut, spawnError }`, with `code` 0 only on a clean exit.
 */
export function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: undefined, signal: undefined, timedOut: false, spawnError: error.message })
      return
    }
    const pending = { stdout: '', stderr: '' }
    const take = (stream, chunk) => {
      const parts = (pending[stream] + String(chunk)).split(/\r\n|\n|\r/u)
      pending[stream] = parts.pop()
      for (const part of parts) if (part !== '') options.onLine?.(part)
    }
    child.stdout.on('data', chunk => take('stdout', chunk))
    child.stderr.on('data', chunk => take('stderr', chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, options.timeoutMs ?? VENV_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: undefined, signal: undefined, timedOut: false, spawnError: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      for (const stream of ['stdout', 'stderr']) if (pending[stream] !== '') options.onLine?.(pending[stream])
      resolve({ code, signal, timedOut, spawnError: undefined })
    })
  })
}

/** The environment pip runs in: the environment being built, and nothing that would redirect it. */
export function pipEnvironment(environment) {
  const env = { ...process.env, VIRTUAL_ENV: environment, NO_COLOR: '1' }
  delete env.PIP_REQUIRE_VIRTUALENV
  delete env.PYTHONHOME
  return env
}

/** The environment `python -m venv` runs in: DSH's own, minus anything that names another Python. */
export function venvEnvironment() {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.VIRTUAL_ENV
  delete env.PYTHONHOME
  return env
}

/** The index pip reads: the one the user named, else the one the lock's artifacts live on. */
export function pipIndex(env = process.env) {
  return String(env.PIP_INDEX_URL ?? env.UV_INDEX_URL ?? '').trim() || 'https://pypi.org/simple'
}

/** The `python -m venv` that creates the environment, clearing a half-built one. */
export function venvArguments(environment, options = {}) {
  return ['-m', 'venv', ...(options.clear === true ? ['--clear'] : []), environment]
}

/** The `pip install` that builds the locked dependency set. */
export function pipArguments(root, env = process.env) {
  return [
    '-m', 'pip', 'install',
    '--no-input',
    '--disable-pip-version-check',
    '--progress-bar', 'off',
    '--require-hashes',
    '--no-deps',
    '--only-binary=:all:',
    '--index-url', pipIndex(env),
    '-r', join(root, 'vendor', 'requirements.txt'),
  ]
}

/** The `pip install` of the engine wheel this package ships: local, offline, one file. */
export function wheelArguments(wheel) {
  return [
    '-m', 'pip', 'install',
    '--no-input',
    '--disable-pip-version-check',
    '--progress-bar', 'off',
    '--no-index',
    '--no-deps',
    wheel,
  ]
}

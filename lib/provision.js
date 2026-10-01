/**
 * Installing the engine this plugin drives: one `uv sync` into an environment the package owns.
 *
 * The npm package carries everything its Python half needs to be rebuilt on any machine: the
 * sidecar, the engine as a wheel under `vendor/`, and a `uv.lock` that pins every other dependency
 * by hash. DSH installs plugins with pnpm, which runs no install script the user has not approved,
 * so the environment is built here instead: by the first caller that finds the engine missing, once,
 * while every other caller that needs it waits for that same install.
 *
 * uv itself is never installed from here: a plugin that downloads and runs an installer on its own
 * is a plugin no one can audit. A missing uv is reported with the command that installs it.
 *
 * @module dsh-browser-use/provision
 */

import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's own root: the sidecar, the bundled engine, and the environment built from them. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The Python the environment is built with: the one CI runs, and one every locked wheel covers. */
export const PYTHON_VERSION = '3.12'

/** How long one install may take; the first one downloads Python and about fifteen packages. */
export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/** A failed install is not repeated by every browser call that finds the engine missing meanwhile. */
const RETRY_AFTER_MS = 60 * 1000

const KEPT_LINES = 40

/** Package root -> its install: the one running now, or the last one to finish. */
const installs = new Map()

/** The environment this package builds for itself. */
export function ownEnvironment(root = PACKAGE_ROOT) {
  return join(root, '.venv')
}

/** The interpreter inside a virtualenv. */
export function environmentPython(environment) {
  return process.platform === 'win32'
    ? join(environment, 'Scripts', 'python.exe')
    : join(environment, 'bin', 'python')
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
 * The install, exactly as it runs: the locked dependencies, without the dev group, into `environment`.
 *
 * `--inexact` leaves alone anything else in that environment, such as the dev tools of a checkout;
 * `--no-install-project` installs what the sidecar imports without building the sidecar itself.
 */
export function installArguments(root = PACKAGE_ROOT) {
  return ['sync', '--frozen', '--no-dev', '--no-install-project', '--inexact', '--python', PYTHON_VERSION, '--project', root]
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

/** uv's own diagnosis, shortened: its error line, the first cause, and the last one. */
export function summarize(lines) {
  const start = lines.findIndex(line => /^error:/iu.test(line))
  if (start === -1) return lines.map(line => line.trim()).filter(Boolean).at(-1) ?? ''
  const causes = []
  for (const line of lines.slice(start + 1)) {
    const cause = line.match(/^\s+(?:cause|caused by):\s*(.*)$/iu)
    if (cause) causes.push(cause[1].trim())
    else if (line.trim() !== '') break
  }
  const clip = text => (text.length > 160 ? `${text.slice(0, 159)}…` : text)
  const parts = [lines[start].replace(/^error:\s*/iu, '').trim(), causes[0], causes.at(-1)].filter(Boolean)
  return [...new Set(parts)].map(clip).join(' — ')
}

/** The fix for a failed `uv sync`, decided by what uv said. */
export function fixFor(output, root = PACKAGE_ROOT) {
  const retry = retryText(root)
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
  if (/files\.pythonhosted\.org|error sending request|tcp connect|dns error|connection (?:refused|reset)|timed out|tunnel error|certificate|network/iu.test(output)) {
    return networkFix(root)
  }
  return `fix what uv reported; then ${retry}`
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
 * @returns `{ state: 'installing' | 'installed' | 'failed', code, root, environment, uv, command,
 *   startedAt, finishedAt, step, output, error, fix }`; `code` names a failure: `no_uv`,
 *   `uv_failed`, `timeout`, or `spawn_failed`.
 */
export function installStatus(root = PACKAGE_ROOT) {
  const record = installs.get(resolve(root))
  return record === undefined ? undefined : snapshot(record.status)
}

/**
 * Build the environment, or join the install already building it.
 *
 * A failed install answers again for a minute without running uv, so a burst of browser calls does
 * not become a burst of downloads; `force` — the user asking for it — runs it at once. A missing uv
 * is looked for again on every call: installing it is the fix, and it needs no restart.
 * @param options - `root`, `environment`, `force`, `timeoutMs`, and `onOutput`, which receives
 *   every line uv prints from now until this install ends.
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
  if (options.force !== true && current?.status.state === 'failed' && current.status.code !== 'no_uv'
      && Date.now() - current.status.finishedAt < RETRY_AFTER_MS) {
    return Promise.resolve(snapshot(current.status))
  }

  const uv = findUv()
  const args = installArguments(root)
  const status = {
    state: 'installing',
    code: undefined,
    root,
    environment,
    uv,
    command: `${uv ?? 'uv'} ${args.join(' ')}`,
    startedAt: Date.now(),
    finishedAt: undefined,
    step: 'starting uv',
    output: [],
    error: undefined,
    fix: undefined,
  }
  const record = { status, listeners: new Set(options.onOutput ? [options.onOutput] : []) }
  installs.set(root, record)
  const finish = (state, failure = {}) => {
    Object.assign(status, { state, finishedAt: Date.now(), ...failure })
    record.listeners.clear()
    return snapshot(status)
  }

  if (uv === undefined) {
    const where = process.env.UV
      ? `UV names ${process.env.UV}, which is not a file`
      : `it is not on PATH or in ${uvDirectories(process.env).join(', ')}`
    record.promise = Promise.resolve(finish('failed', {
      code: 'no_uv',
      error: `the browser engine is installed with uv, and uv was not found: ${where}`,
      fix: `install uv: ${UV_INSTALLER}; then ${retryText(root)}`,
    }))
    return record.promise
  }

  record.promise = new Promise(settle => {
    let done = false
    const end = (state, failure) => {
      if (done) return
      done = true
      settle(finish(state, failure))
    }
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
    let child
    try {
      child = spawn(uv, args, { cwd: root, env: installEnvironment(environment), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      end('failed', { code: 'spawn_failed', error: `${uv} could not be started: ${error.message}`, fix: `check ${uv}; then ${retryText(root)}` })
      return
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, options.timeoutMs ?? INSTALL_TIMEOUT_MS)
    const pending = { stdout: '', stderr: '' }
    const take = (stream, chunk) => {
      const parts = (pending[stream] + String(chunk)).split(/\r\n|\n|\r/u)
      pending[stream] = parts.pop()
      for (const part of parts) line(part)
    }
    child.stdout.on('data', chunk => take('stdout', chunk))
    child.stderr.on('data', chunk => take('stderr', chunk))
    child.on('error', error => {
      clearTimeout(timer)
      end('failed', { code: 'spawn_failed', error: `${uv} could not be started: ${error.message}`, fix: `check ${uv}; then ${retryText(root)}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      for (const stream of ['stdout', 'stderr']) if (pending[stream] !== '') line(pending[stream])
      if (timedOut) {
        end('failed', {
          code: 'timeout',
          error: `uv sync did not finish within ${duration(options.timeoutMs ?? INSTALL_TIMEOUT_MS)} (last: ${status.step})`,
          fix: networkFix(root),
        })
      } else if (code === 0) {
        end('installed')
      } else {
        end('failed', {
          code: 'uv_failed',
          error: summarize(status.output) || `uv sync exited with ${code ?? signal}`,
          fix: fixFor(status.output.join('\n'), root),
        })
      }
    })
  })
  return record.promise
}

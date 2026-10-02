/**
 * Finding, checking, and installing the engine this plugin drives.
 *
 * The plugin itself is JavaScript and installs like a plugin; the engine is a Python package that
 * needs an environment of its own, and nothing in `pnpm add` builds one. So the plugin treats the
 * engine as a **runtime prerequisite it checks and, where it owns the environment, installs**: the
 * package carries the engine as a wheel, the lock's dependencies as hash-pinned requirements, and a
 * `uv.lock` for the machines that use uv, and the first load that finds no engine builds the
 * environment with a Python this machine already has — or with uv when it has none
 * (`./provision.js`, `./python.js`). The same probe serves a doctor tool the model can call, the
 * message a host logs at load, and the refusal a browser tool gives instead of a raw sidecar crash.
 *
 * @module dsh-browser-use/engine
 */

import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'

import {
  PACKAGE_ROOT,
  bundledEngine,
  duration,
  environmentPython,
  environmentRecord,
  findUv,
  installEngine,
  installHint,
  installStatus,
  ownEnvironment,
  retryText,
} from './provision.js'

/** This package's own root: the sidecar ships here, and the environment the plugin builds lives here. */
export { PACKAGE_ROOT }

/** The sidecar that is started, and the one file that has to exist for it to exist. */
export const SIDECAR = join(PACKAGE_ROOT, 'sidecar', 'bridge.py')

/** What the probe asks the interpreter to report; importing the engine imports Browser Harness too. */
const PROBE = [
  '-c',
  [
    'import importlib, importlib.metadata as metadata, json, sys',
    'def installed(name):',
    '    try:',
    '        return metadata.version(name)',
    '    except Exception:',
    '        return "unknown"',
    'engine = importlib.import_module("jev_ultrafast")',
    'harness = importlib.import_module("browser_harness")',
    'json.dump({',
    '    "python": sys.version.split()[0],',
    '    "engine": installed("jev-ultrafast"),',
    '    "enginePath": list(engine.__path__)[0],',
    '    "browserHarness": installed("browser-harness"),',
    '}, sys.stdout)',
  ].join('\n'),
]

const PROBE_TIMEOUT_MS = 30000

/**
 * Interpreter list -> the probe answer that found the engine there.
 *
 * Only a success is kept: an engine that is missing now may be installed a moment later, by this
 * plugin or by the user following the doctor's fix, and the next call has to see that.
 */
const found = new Map()

/** How the environment this package builds for itself is named in reports. */
const OWN = 'this package\u2019s environment'

/**
 * The engine checkout, from the plugin configuration only.
 *
 * The profile is the one place that says which engine runs: an environment variable of the process
 * that launched DSH, or a path baked into this package's own `pyproject.toml`, would silently pick
 * another checkout than the one the profile names.
 */
export function projectRoot(config) {
  const raw = String(config.projectPath ?? '').trim()
  if (raw === '~' || raw.startsWith('~/')) return join(homedir(), raw.slice(1))
  return raw === '' ? '' : resolve(raw)
}

/**
 * Every interpreter worth trying, best first, each with the reason it is on the list.
 *
 * A configured `pythonPath` is the answer or the failure (`inspectEngine` tries nothing else). With
 * a configured `projectPath` the checkout's own virtualenv comes first, then `uv run` in that
 * checkout; this package's environment stays on the list, but the probe only accepts one that
 * imports `jev_ultrafast` from that checkout. Without either, the answer is this package's
 * environment, which the plugin builds itself. An interpreter the system happens to have is never
 * tried: on a Mac without the developer tools, `python3` opens an installer dialog instead of
 * answering.
 */
export function interpreterCandidates(config) {
  const project = projectRoot(config)
  const realProject = project && existsSync(project) ? project : undefined
  const candidates = []
  const add = (command, prefix, cwd, source) => {
    if (candidates.some(item => item.command === command && item.prefix.join(' ') === prefix.join(' '))) return
    candidates.push({ command, prefix, cwd, source })
  }
  if (config.pythonPath) add(config.pythonPath, [], PACKAGE_ROOT, 'pythonPath')
  if (realProject) {
    const checkout = environmentPython(join(realProject, '.venv'))
    if (existsSync(checkout)) add(checkout, [], realProject, 'projectPath virtualenv')
    const uv = findUv()
    if (uv) add(uv, ['run', '--project', realProject, 'python'], realProject, 'uv run in projectPath')
  }
  add(environmentPython(ownEnvironment()), [], PACKAGE_ROOT, OWN)
  return candidates
}

/**
 * Whether this plugin builds the engine's environment itself: only when the profile names no other
 * interpreter and no engine checkout, so an install never replaces an engine someone chose.
 */
export function installable(config) {
  return !config.pythonPath && projectRoot(config) === ''
}

/** Whether `path` is `root` or lies inside it, after resolving symlinks on both. */
function inside(path, root) {
  const real = value => {
    try { return realpathSync(value) } catch { return resolve(value) }
  }
  const child = real(path)
  const parent = real(root)
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** The browser `attach` mode drives: the configured endpoint, or the one you browse with. */
export function attachTarget(config) {
  return config.cdpEndpoint
    ? config.cdpEndpoint
    : 'your running Chrome (found through chrome://inspect remote debugging)'
}

/** The interpreter that runs the sidecar when nothing has probed one yet. */
export function resolveInterpreter(config) {
  return interpreterCandidates(config)[0]
}

/** The browser a launched Session would use: configured, then a PATH entry, then the macOS app. */
export function findBrowser(config) {
  if (config.executablePath) return existsSync(config.executablePath) ? config.executablePath : undefined
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return process.platform === 'darwin' && existsSync(mac) ? mac : undefined
}

/** Run the probe, returning its report or the failure that stopped it. */
function probe(interpreter) {
  if (isAbsolute(interpreter.command) && !existsSync(interpreter.command)) {
    return Promise.resolve({ failure: interpreter.source === OWN ? 'not installed yet' : 'does not exist' })
  }
  return new Promise(resolve => {
    const child = spawn(interpreter.command, [...interpreter.prefix, ...PROBE], {
      cwd: interpreter.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ failure: `the probe did not answer within ${PROBE_TIMEOUT_MS / 1000}s` })
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ failure: `${interpreter.command} could not be started: ${error.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = err.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit status ${code}`
        return resolve({ failure: detail })
      }
      try {
        resolve({ report: JSON.parse(out) })
      } catch {
        resolve({ failure: `the probe answered something unreadable: ${out.slice(0, 120)}` })
      }
    })
  })
}

/**
 * Probe the candidates in order: the first interpreter that imports the engine is the one the
 * sidecar runs on, and every one tried before it is kept, so a failure explains each environment it
 * tried instead of only the first.
 */
async function findEngine(candidates, project) {
  const search = { interpreter: candidates[0], attempts: [] }
  for (const candidate of candidates) {
    const result = await probe(candidate)
    if (result.report !== undefined && project && !inside(result.report.enginePath, project)) {
      search.attempts.push({
        ...candidate,
        failure: `imports jev_ultrafast from ${result.report.enginePath}, not from projectPath ${project}`,
      })
      continue
    }
    if (result.report !== undefined) {
      search.interpreter = candidate
      search.engine = result.report
      break
    }
    search.attempts.push({ ...candidate, failure: result.failure })
  }
  return search
}

/** The problem a missing engine is, and its fix, which depends on who owns the environment. */
function missingEngine(config, report) {
  const tried = report.attempts.map(item => `${item.command} (${item.source}): ${item.failure}`).join('\n    ')
  const project = report.project
  if (project && !existsSync(project)) {
    return ['no_project', `the configured projectPath does not exist: ${project}`,
      'correct config.projectPath, or clear it and the plugin installs the engine it bundles']
  }
  if (config.pythonPath) {
    const wheel = bundledEngine()
    return ['no_engine', tried,
      `install the engine into that interpreter${wheel ? ` (uv pip install --python ${config.pythonPath} ${wheel.path})` : ''}, `
      + 'or clear config.pythonPath and the plugin installs an environment of its own']
  }
  if (project) {
    return ['no_engine', tried,
      `build the checkout's environment (cd ${project} && uv sync), or clear config.projectPath and the plugin installs the engine it bundles`]
  }
  const status = report.install
  if (status === undefined) {
    return ['no_engine', `the browser engine is not installed yet in ${ownEnvironment()}`,
      `the next browser call installs it; to install it now: ${installHint()}`]
  }
  if (status.state === 'installing') {
    return ['installing',
      `the browser engine is being installed into ${status.environment} (for ${duration(Date.now() - status.startedAt)}; ${status.step})`,
      'wait: browser calls wait for this install, and browser_doctor shows how far it got']
  }
  if (status.state === 'failed') {
    return status.code === 'no_uv' || status.code === 'no_python'
      ? [status.code, status.error, status.fix]
      : ['install_failed', `installing the browser engine failed: ${status.error}`, status.fix]
  }
  return ['install_failed',
    `the browser engine was installed into ${status.environment}, and it still does not import: ${report.attempts.at(-1)?.failure ?? 'no answer'}`,
    `delete ${status.environment}, then ${retryText()}`]
}

/**
 * Everything a person needs to know before the first browser tool call.
 *
 * This only looks: `ensureEngine` is what installs a missing engine.
 * @param config - resolved plugin configuration.
 * @param options - `fresh` skips the remembered answer, for a doctor call the user just asked for.
 * @returns the report, with `ok` and a list of problems that name their own fix.
 */
export async function inspectEngine(config, options = {}) {
  // An explicitly configured interpreter is the answer or the failure: falling back to another one
  // would silently ignore what the profile asked for.
  const candidates = config.pythonPath
    ? interpreterCandidates(config).slice(0, 1)
    : interpreterCandidates(config)
  const project = projectRoot(config)
  const key = [project, ...candidates.map(item => [item.command, ...item.prefix].join(' '))].join('\u0000')
  let search = options.fresh === true ? undefined : found.get(key)
  if (search === undefined) {
    search = await findEngine(candidates, project)
    if (search.engine === undefined) found.delete(key)
    else found.set(key, search)
  }

  const report = { ok: true, sidecar: SIDECAR, interpreter: search.interpreter, attempts: [...search.attempts], project, problems: [] }
  if (search.engine !== undefined) report.engine = search.engine
  if (installable(config)) report.install = installStatus()
  if (config.mode === 'attach') {
    report.problems.push({
      code: 'attach',
      message: `mode "attach" drives ${attachTarget(config)} instead of launching one`,
      fix: config.cdpEndpoint
        ? 'nothing to check here: the endpoint belongs to whoever started that browser'
        : 'turn on chrome://inspect/#remote-debugging in that Chrome; on macOS DSH also needs Full Disk Access',
      informational: true,
    })
  }
  const problem = (code, message, fix) => {
    report.problems.push({ code, message, fix })
    report.ok = false
  }

  if (!existsSync(report.sidecar)) {
    problem('no_sidecar', `the sidecar is missing: ${report.sidecar}`,
            'reinstall the plugin: its Python half ships beside lib/')
  }
  if (report.engine === undefined) problem(...missingEngine(config, report))

  if (config.mode !== 'attach') {
    report.browser = findBrowser(config)
    if (report.browser === undefined) {
      problem(
        'no_browser',
        'no Chrome or Chromium executable was found',
        'install Chrome, or set config.executablePath to the browser to launch',
      )
    }
  }
  if (config.jev?.enabled && report.engine !== undefined) {
    report.goalMode = 'enabled: browser_goal and browser_act intents spend TypeSafe and text-model quota'
  }
  return report
}

/**
 * The engine report, after installing the engine if this plugin owns the environment and finds none.
 *
 * The first caller starts the install and every caller meanwhile waits for that same one, so the
 * load-time check, a browser call, and a doctor call never run two installs.
 * @param config - resolved plugin configuration.
 * @param options - `install` retries a failed install at once instead of repeating its answer;
 *   `fresh` probes again first; `onInstall(status)` hears that an install is running;
 *   `onOutput(line)` receives uv's output while it does.
 * @returns the report after the install settled, or at once when nothing had to be installed.
 */
export async function ensureEngine(config, options = {}) {
  const report = await inspectEngine(config, { fresh: options.fresh })
  if (report.engine !== undefined || !installable(config)) return report
  const install = installEngine({ force: options.install === true, onOutput: options.onOutput })
  const status = installStatus()
  if (status?.state === 'installing') options.onInstall?.(status)
  await install
  return inspectEngine(config, { fresh: true })
}

/** Drop the remembered answers, so the next check runs the probe again. */
export function forgetEngine() {
  found.clear()
}

/** One line on the install this plugin ran, or is running, for its own environment. */
function installLine(status, environment) {
  if (status === undefined) {
    const record = environmentRecord(environment)
    return record === undefined
      ? 'none in this process; the engine is already importable'
      : `built with ${record.strategy} on ${String(record.installedAt).slice(0, 10)} (Python ${record.version})`
  }
  const how = status.strategy === 'uv' ? 'uv'
    : status.strategy === 'python' ? `pip (Python ${status.pythonVersion ?? 'unknown'})`
      : 'an installer'
  if (status.state === 'installing') {
    return `running for ${duration(Date.now() - status.startedAt)} into ${status.environment} with ${how} (${status.step})`
  }
  const took = duration(status.finishedAt - status.startedAt)
  if (status.state === 'installed') {
    return `installed into ${status.environment} with ${how} in ${took}; pillow is skipped (this plugin never calls the helpers that use it)`
  }
  if (status.code === 'no_python' || status.code === 'no_uv') return 'not possible: no Python 3.12+ and no uv'
  return `failed ${duration(Date.now() - status.finishedAt)} ago, after ${took}: ${status.command ?? status.error}`
}

/** The report as text: what is ready, what is not, and the command that fixes each problem. */
export function reportText(report, extra = {}) {
  const lines = []
  if (report.engine === undefined) {
    lines.push(
      `Engine   : not usable — tried ${report.attempts.length} interpreter(s)`,
      ...report.attempts.map(item => `           ${item.command} (${item.source}): ${item.failure}`),
    )
  } else {
    lines.push(
      `Engine   : ${report.interpreter.command} (Python ${report.engine.python}, chosen by ${report.interpreter.source})`,
      `           jev_ultrafast ${report.engine.engine} at ${report.engine.enginePath}`,
      `           browser-harness ${report.engine.browserHarness}`,
    )
  }
  if (report.install !== undefined) {
    lines.push(`Install  : ${installLine(report.install, report.install.environment ?? ownEnvironment())}`)
  }
  if (report.browser === undefined && report.interpreter !== undefined && report.problems.every(item => item.code !== 'no_browser')) {
    lines.push('Browser  : the browser in use was started elsewhere (attach mode)')
  } else {
    lines.push(`Sidecar  : ${report.sidecar}`)
  lines.push(`Browser  : ${report.browser ?? 'none found'}`)
  }
  for (const [label, value] of Object.entries(extra)) lines.push(`${label.padEnd(9)}: ${value}`)
  const problems = report.problems.filter(item => item.informational !== true)
  if (problems.length === 0) {
    lines.push('Status   : ready')
  } else {
    lines.push('Problems :')
    for (const item of problems) lines.push(`  - ${item.message}`, `    fix: ${item.fix}`)
  }
  return lines.join('\n')
}

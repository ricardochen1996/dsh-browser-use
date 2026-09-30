/**
 * Finding and checking the engine this plugin drives.
 *
 * The plugin itself is JavaScript and installs like a plugin; the engine is a Python package with its
 * own virtualenv, and nothing in `pnpm add` can install or verify that. So the plugin treats the
 * engine as a **runtime prerequisite it checks**, not one it assumes: the same probe serves a doctor
 * tool the model can call, the warning a host logs at load, and the refusal a browser tool gives
 * instead of a raw sidecar crash.
 *
 * @module dsh-browser-use/engine
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's own root: the sidecar ships here, and so does the environment `uv sync` builds. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
const cache = new Map()

/** The engine checkout: profile config first, then an environment variable. */
export function projectRoot(config) {
  return String(
    config.projectPath || process.env.DSH_BROWSER_USE_PROJECT || process.env.JEV_ULTRAFAST_PROJECT || '',
  ).trim()
}

/**
 * Every interpreter worth trying, best first, each with the reason it is on the list.
 *
 * `uv sync` inside this package builds its own environment with the engine installed as a path
 * dependency, so that one comes first. An engine checkout's own virtualenv is next — it is the
 * environment the project's README tells people to create. `uv run --project` covers a checkout with
 * no virtualenv yet, and a bare `python3` covers an engine installed as a wheel.
 */
export function interpreterCandidates(config) {
  const project = projectRoot(config)
  const realProject = project && existsSync(project) ? project : undefined
  const candidates = []
  const add = (command, prefix, cwd, source) => {
    if (!command) return
    if (candidates.some(item => item.command === command && item.prefix.join(' ') === prefix.join(' '))) return
    candidates.push({ command, prefix, cwd, source })
  }
  if (config.pythonPath) add(config.pythonPath, [], PACKAGE_ROOT, 'pythonPath')

  const own = join(PACKAGE_ROOT, '.venv', 'bin', 'python')
  if (existsSync(own)) add(own, [], PACKAGE_ROOT, 'this package\u2019s virtualenv (uv sync)')

  const checkout = realProject ? join(realProject, '.venv', 'bin', 'python') : ''
  if (checkout && existsSync(checkout)) add(checkout, [], realProject, 'engine checkout virtualenv')

  const uv = ['/opt/homebrew/bin/uv', '/usr/local/bin/uv', join(homedir(), '.local', 'bin', 'uv')]
    .find(candidate => existsSync(candidate))
  if (uv) {
    if (realProject) add(uv, ['run', '--project', realProject, 'python'], realProject, 'uv run in the engine checkout')
    add(uv, ['run', '--project', PACKAGE_ROOT, 'python'], PACKAGE_ROOT, 'uv run in this package')
  }
  add(process.platform === 'win32' ? 'python' : 'python3', [], PACKAGE_ROOT, 'system python3')
  return candidates
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
 * Everything a person needs to know before the first browser tool call.
 * @param config - resolved plugin configuration.
 * @param options - `fresh` skips the cached answer, for a doctor call the user just asked for.
 * @returns the report, with `ok` and a list of problems that name their own fix.
 */
export async function inspectEngine(config, options = {}) {
  // An explicitly configured interpreter is the answer or the failure: falling back to another one
  // would silently ignore what the profile asked for.
  const candidates = config.pythonPath
    ? interpreterCandidates(config).slice(0, 1)
    : interpreterCandidates(config)
  const key = candidates.map(item => [item.command, ...item.prefix].join(' ')).join('\u0000')
  if (options.fresh !== true && cache.has(key)) return cache.get(key)

  const report = { ok: true, sidecar: SIDECAR, interpreter: candidates[0], attempts: [], project: projectRoot(config), problems: [] }
  if (config.mode === 'attach') {
    report.problems.push({
      code: 'attach',
      message: `mode "attach" drives the browser at ${config.cdpEndpoint} instead of launching one`,
      fix: 'nothing to check here: the endpoint belongs to whoever started that browser',
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

  // The first interpreter that can import the engine is the one the sidecar runs on; the others are
  // kept as attempted, so a failure explains every environment it tried instead of only the first.
  for (const candidate of candidates) {
    const result = await probe(candidate)
    if (result.report !== undefined) {
      report.interpreter = candidate
      report.engine = result.report
      break
    }
    report.attempts.push({ ...candidate, failure: result.failure })
  }
  if (report.engine === undefined) {
    const project = report.project && !existsSync(report.project) ? report.project : undefined
    problem(
      project ? 'no_project' : 'no_engine',
      project
        ? `the configured projectPath does not exist: ${project}`
        : candidates.map(item => `${item.command} (${item.source}): ${report.attempts.find(attempt => attempt.command === item.command)?.failure ?? 'not tried'}`).join('\n    '),
      project
        ? 'correct config.projectPath, or drop it and set config.pythonPath to an interpreter that already imports jev_ultrafast'
        : `install the engine: uv sync in ${PACKAGE_ROOT} (or cd ${report.project || '../jev-ultrafast'} && uv sync)`,
    )
  }

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
  if (config.allowGoalMode && report.engine !== undefined) {
    report.goalMode = 'enabled: browser_goal spends TypeSafe and text-model quota'
  }
  cache.set(key, report)
  return report
}

/** Drop the cached answer, so the next check runs the probe again. */
export function forgetEngine() {
  cache.clear()
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

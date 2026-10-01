/**
 * Installing the engine, driven by a fake uv: what runs, what a failure says, and who waits for whom.
 *
 * Run with `node test/provision.mjs`. The plugin's modules are copied into temporary package roots,
 * so every environment they build is a temporary one; uv is a script that writes a fake interpreter
 * or prints the errors uv prints. Nothing is downloaded, no browser starts, and no model is called.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform === 'win32') {
  console.log('SKIP: the provision checks run a POSIX shell script as uv')
  process.exit(0)
}

const passed = []
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbu-provision-')))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/** The fake uv: it records how it was run, then behaves as `FAKE_UV_MODE` says. */
const FAKE_UV_SOURCE = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const environment = process.env.UV_PROJECT_ENVIRONMENT
fs.appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  environment,
  virtualEnv: process.env.VIRTUAL_ENV ?? null,
  uvLocked: process.env.UV_LOCKED ?? null,
  noColor: process.env.NO_COLOR ?? null,
}) + '\n')
const say = line => process.stderr.write(line + '\n')
const interpreter = body => {
  fs.mkdirSync(path.join(environment, 'bin'), { recursive: true })
  const file = path.join(environment, 'bin', 'python')
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}
const engine = () => interpreter('#!/bin/sh\nprintf %s \'' + JSON.stringify({
  python: '3.12.0',
  engine: '0.1.0',
  enginePath: path.join(environment, 'lib', 'python3.12', 'site-packages', 'jev_ultrafast'),
  browserHarness: '0.1.13',
}) + '\'\n')
switch (process.env.FAKE_UV_MODE) {
  case 'ok':
    say('Using CPython 3.12.0')
    say('Creating virtual environment at: ' + environment)
    engine()
    say('Installed 15 packages in 120ms')
    break
  case 'slow':
    say('Resolved 15 packages in 3ms')
    setTimeout(() => {
      engine()
      say('Installed 15 packages in 120ms')
    }, 800)
    break
  case 'network':
    say('Using CPython 3.12.0')
    say('error: Failed to download ' + '\x60pillow==12.3.0\x60')
    say('  cause: Failed to fetch: \x60https://files.pythonhosted.org/packages/pillow-12.3.0.whl\x60')
    say('  cause: error sending request for url (https://files.pythonhosted.org/packages/pillow-12.3.0.whl)')
    say('  cause: tcp connect error')
    say('  cause: Connection refused (os error 61)')
    say('')
    say('hint: \x60pillow\x60 (v12.3.0) was included because \x60dsh-browser-use-sidecar\x60 depends on \x60pillow\x60')
    process.exitCode = 2
    break
  case 'python':
    say('error: No interpreter found for Python 3.12 in managed installations')
    process.exitCode = 2
    break
  case 'broken':
    interpreter('#!/bin/sh\necho "ModuleNotFoundError: No module named \'browser_harness\'" >&2\nexit 1\n')
    say('Installed 15 packages in 120ms')
    break
  case 'hang':
    say('Downloading cpython-3.12.0-macos-aarch64-none (download) (17.0MiB)')
    setInterval(() => {}, 1000)
    break
  default:
    say('error: unknown FAKE_UV_MODE')
    process.exitCode = 2
}
`

const FAKE_UV = join(scratch, 'uv')
writeFileSync(join(scratch, 'fake-uv.cjs'), FAKE_UV_SOURCE)
writeFileSync(FAKE_UV, `#!/bin/sh\nexec "${process.execPath}" "${join(scratch, 'fake-uv.cjs')}" "$@"\n`)
chmodSync(FAKE_UV, 0o755)
const LOG = join(scratch, 'uv.log')
process.env.UV = FAKE_UV
process.env.FAKE_UV_LOG = LOG
const useUv = mode => { process.env.FAKE_UV_MODE = mode }

/** Every run of the fake uv so far. */
const calls = () => (existsSync(LOG)
  ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [])

const ENGINE_PROBLEMS = ['no_engine', 'installing', 'install_failed', 'no_uv', 'no_project']

/** A copy of this package's runtime half, so the environment it builds is a temporary one. */
function copyPackage(name) {
  const root = join(scratch, name)
  cpSync(join(PACKAGE_ROOT, 'lib'), join(root, 'lib'), { recursive: true })
  for (const file of ['package.json', 'sidecar/bridge.py', 'bin/doctor.mjs', 'vendor/jev-ultrafast.json']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    cpSync(join(PACKAGE_ROOT, file), join(root, file))
  }
  return root
}

const load = (root, module) => import(pathToFileURL(join(root, 'lib', `${module}.js`)).href)

function directory(name) {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

async function waitFor(condition, what) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`FAIL: timed out waiting for ${what}`)
    await new Promise(settle => setTimeout(settle, 10))
  }
}

const PILLOW = 'Failed to download `pillow==12.3.0` — Failed to fetch: '
  + '`https://files.pythonhosted.org/packages/pillow-12.3.0.whl` — Connection refused (os error 61)'

/** uv's diagnosis becomes one line, the fix follows from what uv said, and uv is found where it lives. */
async function diagnosis() {
  const provision = await load(PACKAGE_ROOT, 'provision')
  const start = passed.length
  const output = [
    'Using CPython 3.12.14',
    'Creating virtual environment at: /tmp/package/.venv',
    'error: Failed to download `pillow==12.3.0`',
    '  cause: Failed to fetch: `https://files.pythonhosted.org/packages/pillow-12.3.0.whl`',
    '  cause: error sending request for url (https://files.pythonhosted.org/packages/pillow-12.3.0.whl)',
    '  cause: tcp connect error',
    '  cause: Connection refused (os error 61)',
    '',
    'hint: `pillow` (v12.3.0) was included because `dsh-browser-use-sidecar` depends on `pillow`',
  ]
  check(provision.summarize(output) === PILLOW, 'a uv failure reads as its error, its first cause, and its last')
  check(provision.summarize(['error: Failed to build `x`', '  Caused by: No space left on device (os error 28)'])
    === 'Failed to build `x` — No space left on device (os error 28)', 'the older "Caused by:" form is read too')
  check(provision.summarize(['Resolved 15 packages', 'something odd', '']) === 'something odd',
    'without an error line, the last thing uv said stands')
  check(/HTTPS_PROXY/u.test(provision.fixFor(output.join('\n'))), 'a download that failed on the network gets the proxy fix')
  check(/uv python install 3\.12/u.test(provision.fixFor('error: No interpreter found for Python 3.12 in managed installations')),
    'a Python uv could not get gets the Python fix')
  check(/writable/u.test(provision.fixFor('error: failed to create directory `/x/.venv`: Permission denied (os error 13)')),
    'a package directory that cannot be written gets the permissions fix')
  check(/^fix what uv reported; then retry: browser_doctor with install: true/u.test(provision.fixFor('error: something new')),
    'anything else points at uv\u2019s own message and the retry')
  check(provision.duration(42000) === '42s' && provision.duration(185000) === '3m 5s' && provision.duration(120000) === '2m',
    'durations read as a person reads them')
  check(provision.installArguments('/package').join(' ')
    === 'sync --frozen --no-dev --no-install-project --inexact --python 3.12 --project /package',
  'the install is a frozen sync of the lock, without dev tools, on Python 3.12')

  check(provision.findUv({ UV: join(scratch, 'no-such-uv'), PATH: dirname(FAKE_UV) }) === undefined,
    'a UV that names nothing is reported, not passed over for another uv')
  check(provision.findUv({ UV: FAKE_UV }) === FAKE_UV, 'UV names the uv to run')
  const bin = directory('path-bin')
  writeFileSync(join(bin, 'uv'), '')
  check(provision.findUv({ PATH: bin }) === join(bin, 'uv'), 'uv is found on PATH')

  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'vendor', 'jev-ultrafast.json'), 'utf8'))
  const bundled = provision.bundledEngine()
  check(bundled?.version === manifest.version && bundled.path === join(PACKAGE_ROOT, 'vendor', manifest.wheel) && existsSync(bundled.path),
    'the bundled engine is a wheel that ships beside the manifest naming it')
  check(provision.bundledEngine(directory('no-vendor')) === undefined, 'a package root without a manifest bundles no engine')
  console.log(`PASS: ${passed.length - start} diagnosis checks; no uv`)
}

/** One install per package root: what runs, what it is told, and how a failure or a stuck uv ends. */
async function installs() {
  const provision = await load(PACKAGE_ROOT, 'provision')
  const start = passed.length

  const root = directory('install-ok')
  process.env.VIRTUAL_ENV = join(scratch, 'someone-elses-venv')
  process.env.UV_LOCKED = '1'
  useUv('ok')
  const heard = []
  const status = await provision.installEngine({ root, onOutput: line => heard.push(line) })
  delete process.env.VIRTUAL_ENV
  delete process.env.UV_LOCKED
  const call = calls().at(-1)
  check(status.state === 'installed' && status.code === undefined && status.finishedAt >= status.startedAt,
    'a uv sync that exits 0 is an installed engine')
  check(existsSync(join(root, '.venv', 'bin', 'python')), 'the environment is built inside the package root')
  check(call.args.join(' ') === provision.installArguments(root).join(' ') && call.cwd === root,
    'uv runs the documented sync, from the package root')
  check(call.environment === join(root, '.venv'), 'uv builds the package\u2019s own environment')
  check(call.virtualEnv === null && call.uvLocked === null && call.noColor === '1',
    'an activated virtualenv or UV_LOCKED in DSH\u2019s environment does not leak into the install')
  check(heard.includes('Installed 15 packages in 120ms') && status.step === 'Installed 15 packages in 120ms',
    'every line uv prints reaches the listener, and the last one is the step')
  check(provision.installStatus(root)?.state === 'installed' && provision.installStatus(directory('never')) === undefined,
    'the status is kept per package root')

  const joined = directory('install-join')
  useUv('slow')
  const before = calls().length
  const second = []
  const first = provision.installEngine({ root: joined })
  check(provision.installStatus(joined).state === 'installing', 'a running install reports itself as installing')
  const again = provision.installEngine({ root: joined, onOutput: line => second.push(line) })
  check(first === again, 'a second caller joins the install that is running')
  await first
  check(calls().length === before + 1, 'callers that join it run uv once between them')
  check(second.includes('Installed 15 packages in 120ms'), 'a caller that joined hears the rest of the output')

  useUv('ok')
  const sturdy = await provision.installEngine({ root: directory('install-listener'), onOutput: () => { throw new Error('listener') } })
  check(sturdy.state === 'installed', 'a listener that throws does not stop the install')

  const failing = directory('install-fail')
  useUv('network')
  const failed = await provision.installEngine({ root: failing })
  check(failed.state === 'failed' && failed.code === 'uv_failed', 'a uv sync that exits non-zero is a failed install')
  check(failed.error === PILLOW, 'the failure says what uv said, shortened')
  check(/HTTPS_PROXY/u.test(failed.fix) && failed.fix.includes('browser_doctor with install: true'),
    'its fix names the proxy setting and how to retry')
  check(failed.output.some(line => line.startsWith('hint:')), 'uv\u2019s full output is kept for the doctor')
  useUv('ok')
  const count = calls().length
  const repeated = await provision.installEngine({ root: failing })
  check(repeated.state === 'failed' && calls().length === count, 'a failed install answers again for a while without running uv')
  const forced = await provision.installEngine({ root: failing, force: true })
  check(forced.state === 'installed' && calls().length === count + 1, 'asking for the install runs it again at once')

  const python = directory('install-python')
  useUv('python')
  const nopython = await provision.installEngine({ root: python })
  check(nopython.error === 'No interpreter found for Python 3.12 in managed installations' && /uv python install 3\.12/u.test(nopython.fix),
    'a Python uv cannot get is named, with its fix')

  const missing = directory('install-no-uv')
  process.env.UV = join(scratch, 'no-such-uv')
  const none = await provision.installEngine({ root: missing })
  check(none.state === 'failed' && none.code === 'no_uv' && none.error.includes(`UV names ${join(scratch, 'no-such-uv')}`),
    'a missing uv is a failure that says where it was looked for')
  check(/^install uv: .+; then retry: /u.test(none.fix), 'its fix is the command that installs uv')
  process.env.UV = FAKE_UV
  useUv('ok')
  const found = await provision.installEngine({ root: missing })
  check(found.state === 'installed', 'uv is looked for again on the next call: installing it needs no restart')

  const stuck = directory('install-hang')
  useUv('hang')
  const started = Date.now()
  const late = await provision.installEngine({ root: stuck, timeoutMs: 400 })
  check(late.code === 'timeout' && /did not finish within/u.test(late.error) && late.error.includes('Downloading cpython-3.12.0'),
    'a uv that does not finish is stopped, and the failure names what it was doing')
  check(Date.now() - started < 4000 && /HTTPS_PROXY/u.test(late.fix), 'a stuck install ends promptly, with the network fix')
  console.log(`PASS: ${passed.length - start} install checks; fake uv, no download`)
}

/** The engine report and `ensureEngine` in a package that builds its own environment. */
async function engineInstalls() {
  const start = passed.length
  const config = { mode: 'launch', jev: { enabled: false } }
  const root = copyPackage('package-ok')
  const engine = await load(root, 'engine')
  const environment = join(root, '.venv')
  const python = join(environment, 'bin', 'python')

  check(engine.installable(config) && !engine.installable({ pythonPath: '/x' }) && !engine.installable({ projectPath: '/x' }),
    'the plugin installs only when the profile names no interpreter and no checkout')
  const candidates = engine.interpreterCandidates(config)
  check(candidates.length === 1 && candidates[0].command === python && engine.resolveInterpreter(config).command === python,
    'with neither, the one interpreter is the package\u2019s own environment; no system Python is tried')

  const fresh = await engine.inspectEngine(config, { fresh: true })
  const missing = fresh.problems.find(item => item.code === 'no_engine')
  check(missing && missing.message === `the browser engine is not installed yet in ${environment}`
    && missing.fix.includes('the next browser call installs it') && missing.fix.includes('browser_doctor with install: true'),
  'before any install, the report says the engine is not installed yet and how it gets installed')
  check(fresh.attempts[0]?.failure === 'not installed yet' && fresh.install === undefined && !engine.reportText(fresh).includes('Install  :'),
    'an environment that does not exist is not run, and no install is reported before one was asked for')

  useUv('slow')
  const count = calls().length
  const told = []
  const heard = []
  const ensured = engine.ensureEngine(config, { onInstall: status => told.push(status), onOutput: line => heard.push(line) })
  await waitFor(() => told.length > 0, 'the install to start')
  check(told.length === 1 && told[0].state === 'installing' && told[0].environment === environment,
    'the caller that starts an install hears that it started')
  const during = await engine.inspectEngine(config, { fresh: true })
  check(during.problems.some(item => item.code === 'installing' && item.message.startsWith(`the browser engine is being installed into ${environment}`)),
    'a check during the install says it is running')
  check(/Install  : running for \d+s into /u.test(engine.reportText(during)), 'the report says how long it has run')
  const waiting = engine.ensureEngine(config)
  const [after, joined] = await Promise.all([ensured, waiting])
  check(calls().length === count + 1, 'a browser call during the install waits for the same install')
  check(after.engine?.engine === '0.1.0' && after.interpreter.command === python && joined.engine?.engine === '0.1.0',
    'after the install, the engine is found in the package\u2019s environment')
  check(!after.problems.some(item => ENGINE_PROBLEMS.includes(item.code)), 'no engine problem is left')
  check(/Install  : installed into .+ in \d+s/u.test(engine.reportText(after)), 'the report keeps the install it ran')
  check(heard.includes('Installed 15 packages in 120ms'), 'uv\u2019s output reached the caller that asked for it')
  await engine.ensureEngine(config)
  check(calls().length === count + 1, 'an engine that was found is not installed again')

  const configured = await engine.ensureEngine({ mode: 'launch', pythonPath: join(scratch, 'no-python') })
  const named = configured.problems.find(item => item.code === 'no_engine')
  check(calls().length === count + 1 && named?.fix.includes(`uv pip install --python ${join(scratch, 'no-python')} `),
    'an interpreter the profile names is never installed into; the fix says how to do it')

  const failingRoot = copyPackage('package-fail')
  const failing = await load(failingRoot, 'engine')
  useUv('network')
  const failed = await failing.ensureEngine(config)
  const problem = failed.problems.find(item => item.code === 'install_failed')
  check(problem?.message === `installing the browser engine failed: ${PILLOW}` && /HTTPS_PROXY/u.test(problem.fix),
    'a failed install is the problem, with uv\u2019s reason and the fix')
  check(/Install  : failed \d+s ago, after \d+s: .*uv sync --frozen/u.test(failing.reportText(failed)), 'the report names the command that failed')
  useUv('ok')
  const retries = calls().length
  const meanwhile = await failing.ensureEngine(config)
  check(calls().length === retries && meanwhile.problems.some(item => item.code === 'install_failed'),
    'a browser call right after a failure gets that answer without another download')
  const retried = await failing.ensureEngine(config, { install: true })
  check(retried.engine?.engine === '0.1.0' && calls().length === retries + 1, 'asking for the install retries it at once')

  const lackingRoot = copyPackage('package-no-uv')
  const lacking = await load(lackingRoot, 'engine')
  process.env.UV = join(scratch, 'no-such-uv')
  const nouv = await lacking.ensureEngine(config)
  process.env.UV = FAKE_UV
  check(nouv.problems.some(item => item.code === 'no_uv' && /uv was not found/u.test(item.message) && /^install uv: /u.test(item.fix)),
    'without uv, the problem is uv, with the command that installs it')
  check(lacking.reportText(nouv).includes('Install  : not possible: uv was not found'), 'the report says the install could not run')

  const brokenRoot = copyPackage('package-broken')
  const broken = await load(brokenRoot, 'engine')
  useUv('broken')
  const unusable = await broken.ensureEngine(config)
  const left = unusable.problems.find(item => item.code === 'install_failed')
  check(left?.message.includes('still does not import: ModuleNotFoundError: No module named \'browser_harness\'')
    && left.fix.startsWith(`delete ${join(brokenRoot, '.venv')}, then retry: `),
  'an install that leaves an engine that does not import says so, and how to start over')
  console.log(`PASS: ${passed.length - start} engine-install checks; fake uv, no browser`)
}

/** A cancelled browser call stops waiting; the install it started goes on for the next call. */
async function cancelledWait() {
  const start = passed.length
  const root = copyPackage('package-cancel')
  const { Sidecar, abortable } = await load(root, 'sidecar')
  const provision = await load(root, 'provision')

  const work = new Promise(settle => setTimeout(() => settle('done'), 30))
  check(abortable(work, undefined) === work, 'without a signal, the wait is the work itself')
  const aborted = new AbortController()
  aborted.abort()
  check(await abortable(Promise.resolve(1), aborted.signal).then(() => 'settled', error => error.kind) === 'cancelled',
    'an aborted signal cancels the wait at once')

  useUv('slow')
  const sidecar = new Sidecar({ config: { mode: 'launch', jev: { enabled: false } }, label: 'cancel' })
  const controller = new AbortController()
  const waiting = sidecar.ready(controller.signal).then(() => undefined, error => error)
  await waitFor(() => provision.installStatus()?.state === 'installing', 'the install to start')
  controller.abort()
  const error = await waiting
  check(error?.kind === 'cancelled' && /cancelled while it waited for the browser engine install/u.test(error.message)
    && /The install goes on/u.test(error.message), 'a cancelled call says it stopped waiting, and that the install goes on')
  await waitFor(() => provision.installStatus()?.state !== 'installing', 'the install to finish')
  check(provision.installStatus().state === 'installed' && existsSync(join(root, '.venv', 'bin', 'python')),
    'the install a cancelled call started finishes anyway')
  console.log(`PASS: ${passed.length - start} cancellation checks; fake uv, no browser`)
}

/** The doctor tool and the doctor command install on request, and only then. */
async function doctors() {
  const start = passed.length
  const root = copyPackage('package-doctor')
  const tools = await load(root, 'tools')
  const doctor = tools.mountDoctor({ tools: { register: definition => definition } }, {
    config: { mode: 'launch', jev: { enabled: false } },
    sessions: { viewOf: () => undefined },
    delegation: () => 'direct',
    ownerOf: () => undefined,
  })
  check(doctor.parameters.properties.install?.type === 'boolean' && !(doctor.parameters.required ?? []).includes('install'),
    'browser_doctor takes an optional install switch')
  useUv('ok')
  const count = calls().length
  const look = (await doctor.execute({}, { signal: new AbortController().signal })).text
  check(/not installed yet/u.test(look) && calls().length === count, 'without install, the doctor only looks')
  const installed = (await doctor.execute({ install: true }, { signal: new AbortController().signal })).text
  check(/Install  : installed into /u.test(installed) && /jev_ultrafast 0\.1\.0 at /u.test(installed) && calls().length === count + 1,
    'with install: true, the doctor installs the engine and reports it')

  const cliRoot = copyPackage('package-cli')
  const cli = (...args) => spawnSync(process.execPath, [join(cliRoot, 'bin', 'doctor.mjs'), ...args], { encoding: 'utf8' })
  const wrong = cli('--bogus')
  check(wrong.status === 2 && /^usage: node bin\/doctor\.mjs \[--install\]/u.test(wrong.stderr), 'an unknown flag prints the usage and exits 2')
  const report = cli()
  check(report.status === 1 && /not installed yet/u.test(report.stdout) && !existsSync(join(cliRoot, '.venv')),
    'without --install, the command reports the missing engine, installs nothing, and exits 1')
  const run = cli('--install')
  check(/Install  : installed into /u.test(run.stdout) && run.stderr.includes(`installing the browser engine into ${join(cliRoot, '.venv')}: `)
    && run.stderr.includes('  Installed 15 packages in 120ms'), 'with --install it installs, with uv\u2019s output on stderr')
  check(run.status === (/no Chrome or Chromium/u.test(run.stdout) ? 1 : 0), 'its exit status follows the report')
  console.log(`PASS: ${passed.length - start} doctor checks; fake uv, no browser`)
}

await diagnosis()
await installs()
await engineInstalls()
await cancelledWait()
await doctors()
console.log(`PASS: ${passed.length} provision checks`)

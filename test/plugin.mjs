/**
 * The plugin half, driven without DSH: a fake Cordis context, the real engine sidecar, a real browser.
 *
 * Run with `node test/plugin.mjs`. It checks what the model would read in each tool result, so a
 * broken table, a missing operation, or a silent refusal fails here. The engine checkout is found
 * through `DSH_BROWSER_USE_PROJECT` / `JEV_ULTRAFAST_PROJECT`, or beside this package.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = resolve(
  process.env.DSH_BROWSER_USE_PROJECT || process.env.JEV_ULTRAFAST_PROJECT || join(PACKAGE_ROOT, '..', 'jev-ultrafast'),
)
if (!existsSync(join(ENGINE, 'jev_ultrafast', '__init__.py'))) {
  throw new Error(`Set DSH_BROWSER_USE_PROJECT to the engine checkout: no jev_ultrafast package under ${ENGINE}`)
}
const FIXTURE = pathToFileURL(join(ENGINE, 'jev_ultrafast', 'static', 'fixture.html')).href

const passed = []
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}

/** The target index the rendered table offers for one labelled element, as the model would read it. */
function targetFor(text, pattern) {
  const match = text.match(new RegExp(`\\[(\\d+)\\][^\\n]*${pattern}`, 'u'))
  if (!match) throw new Error(`no element matching ${pattern} in:\n${text}`)
  return match[1]
}

/** The observed option target for one dropdown value, as the rendered table lists it. */
function optionFor(text, pattern) {
  const match = text.match(new RegExp(`^\\s+(\\d+:\\d+) → [^\\n]*${pattern}$`, 'mu'))
  if (!match) throw new Error(`no option matching ${pattern} in:\n${text}`)
  return match[1]
}

/** The part of the Cordis context this plugin uses, with the same lifetimes. */
function fakeContext() {
  const tools = new Map()
  const disposers = []
  const listeners = new Map()
  const agent = {
    id: 'session-plugin-check',
    ctx: { effect: callback => { disposers.push(callback()); return () => {} } },
  }
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    agents: { get: id => (id === agent.id ? agent : undefined) },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    logger: { info: () => {}, warn: () => {} },
    get: name => (name === 'agents' ? { get: id => (id === agent.id ? agent : undefined) } : undefined),
    // No subagent provider in this composition, so the plugin stays in direct mode; the event
    // registry is real, because a live config edit arrives as `loader/volatile-update`.
    on: (event, handler) => {
      const registered = listeners.get(event) ?? []
      registered.push(handler)
      listeners.set(event, registered)
      return () => { listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== handler)) }
    },
    emit: (event, ...args) => { for (const handler of [...(listeners.get(event) ?? [])]) handler(...args) },
    effect: callback => {
      const generator = callback()
      let step = generator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = generator.next()
      }
    },
  }
  return {
    ctx,
    tools,
    agent,
    emit: ctx.emit,
    dispose: async () => { for (const dispose of disposers.reverse()) await dispose() },
  }
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-plugin-'))
  const { ctx, tools, agent, dispose } = fakeContext()
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)

  plugin.apply(ctx, {
    projectPath: ENGINE,
    userDataDir: join(profile, 'browser'),
    headless: true,
    jev: { enabled: false },
  })

  const run = (name, args) => tools.get(name).execute(args, { agent, signal: new AbortController().signal })
  try {
    check([...tools.keys()].sort().join(',') === 'browser_act,browser_close,browser_console,browser_doctor,browser_open,browser_page,browser_screenshot',
      `the tool surface is ${[...tools.keys()].join(', ')}`)
    check(!tools.has('browser_goal'), 'goal mode stays off unless the profile asks for it')

    const doctor = await run('browser_doctor', {})
    check(/Status\s*:\s*ready/u.test(doctor.text), 'the doctor reports a ready engine')
    check(doctor.text.includes('jev_ultrafast') && doctor.text.includes('browser-harness'), 'the doctor names the engine it found')

    const opened = await run('browser_open', { url: FIXTURE })
    check(opened.observation === 1, 'the first read is observation 1')
    check(opened.text.includes('Observation 1'), 'the table names the observation the targets belong to')
    check(/\[\d+\] searchbox Destination.*TYPE_TEXT/u.test(opened.text), 'a typeable field is offered with TYPE_TEXT')
    check(/Without a target: .*WAIT/u.test(opened.text), 'operations without a target are listed separately')

    const typed = await run('browser_act', { observation: 1, operation: 'TYPE_TEXT', target: targetFor(opened.text, 'Destination'), text: 'Lisbon' })
    check(typed.observation === 2 && /searchbox Destination · "Lisbon"/u.test(typed.text), 'typing reports the value the page now holds')

    const selected = await run('browser_act', { observation: 2, operation: 'SELECT', target: optionFor(typed.text, 'Design') })
    check(selected.text.includes('Executed SELECT'), 'an observed dropdown option is selectable')

    const submitted = await run('browser_act', { observation: 3, operation: 'CLICK', target: targetFor(selected.text, 'Find stays') })
    check(/Casa Flora/u.test(submitted.text), 'the submitted filters leave the one matching stay on the page')

    const stale = await run('browser_act', { observation: 1, operation: 'CLICK', target: '5' })
    check(stale.text.startsWith('Nothing was executed'), 'an action from an older observation is refused, not applied')
    check(stale.observation > submitted.observation, 'the refusal carries a newer observation to choose from')

    const unknown = await run('browser_act', { observation: 999, operation: 'CLICK', target: '5' })
    check(unknown.text.startsWith('Refused:'), 'an observation this Session never produced is refused')

    const badOperation = await run('browser_act', { observation: 999, operation: 'PRESS_KEY', target: '5' })
    check(badOperation.text.startsWith('Refused:'), 'an operation the browser does not offer is refused')

    const detail = await run('browser_act', {
      observation: submitted.observation,
      operation: 'CLICK',
      target: targetFor(submitted.text, 'View Casa Flora'),
    })
    check(/Destination Lisbon/u.test(detail.text) && /Design/u.test(detail.text),
      'the opened stay reports the typed destination and the chosen category')

    const shot = await run('browser_screenshot', {})
    check(shot.text.includes('Viewport') || shot.text.includes('attachment service'), 'a screenshot answers with its viewport or a clear reason')

    const console_ = await run('browser_console', {})
    check(console_.text.startsWith('Page '), 'console output is reported for the page this Session drives')

    const before = detail.observation
    const closed = await run('browser_close', {})
    check(/stopped/u.test(closed.text), 'closing stops the tab, the browser, and its daemon')
    const reopened = await run('browser_open', { url: FIXTURE })
    check(reopened.observation > before, 'a browser tool after a close opens a fresh browser and a new observation')
    const orphan = await run('browser_act', { observation: before, operation: 'CLICK', target: '5' })
    check(orphan.text.startsWith('Refused:'), 'an observation from the closed browser cannot be acted on')
  } finally {
    await dispose()
    // A browser that was just asked to stop may still be flushing its profile; the temp directory is
    // the operating system's to reclaim either way.
    await new Promise(resolve => setTimeout(resolve, 1500))
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} plugin checks; no model calls`)
}

/**
 * An installation whose engine is missing must say what to install, not surface a sidecar that
 * exited. Nothing here starts a browser: the refusal happens before one is ever needed.
 */
async function missingEngine() {
  const { ctx, tools, agent } = fakeContext()
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  plugin.apply(ctx, { pythonPath: '/nonexistent/python', projectPath: '', mode: 'launch' })
  const run = (name, args) => tools.get(name).execute(args, { agent, signal: new AbortController().signal })

  const doctor = await run('browser_doctor', {})
  check(/not usable/u.test(doctor.text), 'the doctor reports an unusable interpreter')
  check(/fix:/u.test(doctor.text), 'the doctor names the fix for the missing engine')
  check(/projectPath|pythonPath/u.test(doctor.text), 'the fix names the setting that changes it')

  let refusal
  try {
    await run('browser_open', { url: 'https://example.com' })
  } catch (error) {
    refusal = String(error.message ?? error)
  }
  check(refusal !== undefined, 'a browser tool refuses when the engine is missing')
  check(/not ready/u.test(refusal) && refusal.includes('/nonexistent/python'),
    'the refusal carries the same diagnosis instead of a sidecar crash')
  console.log('PASS: 4 missing-engine checks; no browser, no model calls')
}

/**
 * The engine checkout and the goal-mode endpoints and keys come from the plugin configuration only:
 * not from the engine checkout's `.env`, not from DSH's launch environment under the engine's names.
 */
async function engineConfiguration() {
  const engine = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'engine.js')).href)
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  let count = 0
  const ok = (condition, message) => { check(condition, message); count += 1 }

  const report = await engine.inspectEngine({ projectPath: ENGINE, mode: 'launch' }, { fresh: true })
  ok(report.engine !== undefined && report.engine.enginePath.startsWith(ENGINE),
    'the sidecar runs on an interpreter that imports the engine from projectPath')

  const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-browser-use-project-'))
  try {
    const other = await engine.inspectEngine({ projectPath: elsewhere, mode: 'launch' }, { fresh: true })
    ok(other.ok === false && other.engine === undefined,
      'an engine imported from outside projectPath is not used')
    ok(engine.reportText(other).includes(`not from projectPath ${elsewhere}`),
      'the doctor says which checkout the refused interpreter imported instead')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }

  const jev = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'jev.js')).href)
  const refused = message => {
    try { plugin.apply(fakeContext().ctx, message); return undefined } catch (error) { return String(error.message) }
  }
  ok(/jev\.typesafe\.baseURL/u.test(refused({ jev: { typesafe: { baseURL: 'not a url' } } }) ?? ''), 'a bad endpoint URL is refused')
  ok(/apiKeyEnv/u.test(refused({ jev: { source: 'custom', textModel: { apiKeyEnv: 'sk-a key' } } }) ?? ''), 'a key pasted into apiKeyEnv is refused')
  ok(/only applies to jev\.source: custom/u.test(refused({ jev: { source: 'session', textModel: { baseURL: 'https://x.test/v1' } } }) ?? ''),
    'an endpoint or key written for session mode is refused instead of silently ignored')
  ok(/jev\.source/u.test(refused({ jev: { source: 'main' } }) ?? ''), 'an unknown source is refused')
  ok(jev.resolveJevConfig({ allowGoalMode: true }).enabled === true, 'the older allowGoalMode still turns jev on')

  const credentials = { resolve: async name => (name === 'GATEWAY_KEY' ? { value: 'stored-key', source: 'file' } : undefined) }
  const custom = {
    jev: jev.resolveJevConfig({ jev: {
      enabled: true,
      source: 'custom',
      typesafe: { baseURL: 'https://gateway.test/systemone', model: 'jev-1', apiKeyEnv: 'GATEWAY_KEY' },
      textModel: { baseURL: 'https://gateway.test/v1', model: 'text-1', apiKey: 'literal-text-key', reasoning: 'thinking-disabled', headers: { 'x-session': 'dsh' } },
    } }),
  }
  const withCredentials = { get: name => (name === 'credentials' ? credentials : undefined) }
  const { env } = await jev.jevEnvironment(custom, withCredentials, undefined)
  ok(env.TYPESAFE_API_KEY === 'stored-key' && env.TEXT_MODEL_API_KEY === 'literal-text-key',
    'custom: keys come from the named DSH credential or the literal apiKey')
  ok(env.TYPESAFE_BASE_URL === 'https://gateway.test/systemone' && env.TYPESAFE_MODEL === 'jev-1'
    && env.TEXT_MODEL === 'text-1' && env.TEXT_MODEL_REASONING === 'thinking-disabled'
    && env.TEXT_MODEL_HEADERS === '{"x-session":"dsh"}' && !('TYPESAFE_FALLBACK_URL' in env),
  'custom: endpoints, models, reasoning and headers map to the engine variables')

  // A composition whose main conversation runs on a gateway route declared in llm-pi-ai.
  const route = { provider: 'gateway-responses', model: 'deepseek-flash' }
  const profile = { api: 'openai-responses', baseURL: 'https://gateway.test/go/v1', apiKeyEnv: 'GATEWAY_KEY', headers: { 'x-opencode-session': 'dsh' } }
  const composition = profiles => ({
    get: name => ({
      credentials,
      llm: { listConfigurableProviders: () => [{ provider: route.provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', route.provider] }] },
      settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { [route.provider]: profiles } } }] },
    })[name],
  })
  const owner = { session: { requestHeader: () => ({ config: route }) } }
  const session = { jev: jev.resolveJevConfig({ jev: { enabled: true, source: 'session', typesafe: { baseURL: 'https://gateway.test/systemone', model: 'jev-1' } } }) }
  const inherited = await jev.jevEnvironment(session, composition(profile), owner)
  ok(inherited.env.TYPESAFE_API_KEY === 'stored-key' && inherited.env.TEXT_MODEL_API_KEY === 'stored-key'
    && inherited.env.TEXT_MODEL_BASE_URL === profile.baseURL && inherited.env.TEXT_MODEL === 'deepseek-flash'
    && inherited.env.TEXT_MODEL_HEADERS === '{"x-opencode-session":"dsh"}' && inherited.env.TYPESAFE_BASE_URL === 'https://gateway.test/systemone',
  'session: the main conversation\u2019s route supplies the text endpoint, model, headers and both keys')
  route.model = 'glm-5.3'
  ok((await jev.jevEnvironment(session, composition(profile), owner)).env.TEXT_MODEL === 'glm-5.3',
    'session: a model switch in the main conversation reaches the next call')
  const overridden = { jev: jev.resolveJevConfig({ jev: { enabled: true, textModel: { model: 'fast-one', headers: { 'x-extra': '1' } } } }) }
  const override = (await jev.jevEnvironment(overridden, composition(profile), owner)).env
  ok(override.TEXT_MODEL === 'fast-one' && override.TEXT_MODEL_HEADERS === '{"x-opencode-session":"dsh","x-extra":"1"}',
    'session: textModel.model overrides the inherited model and textModel.headers add to the route’s')
  const status = await jev.jevStatus(session, composition({ ...profile, api: 'anthropic-messages' }), owner)
  ok(/NOT USABLE/u.test(status) && /Anthropic/u.test(status) && !status.includes('stored-key'),
    'the doctor explains why a route cannot be inherited, without printing any key')
  ok(/not chosen a model/u.test(await jev.jevStatus(session, composition(profile), { session: { requestHeader: () => undefined } })),
    'a conversation without a model yet says so')
  ok(/jev\.enabled is false/u.test(await jev.jevStatus({ jev: jev.resolveJevConfig({}) }, undefined, owner)),
    'with jev off nothing is resolved')
  console.log(`PASS: ${count} engine-configuration checks; no browser, no model calls`)
}

/**
 * One attached browser belongs to one Session. The refusal is decided before the engine is asked to
 * do anything, so this needs no browser: the first Session takes the reservation and fails on the
 * missing engine, and the second is refused for the reason that matters.
 */
async function attachExclusivity() {
  const { Sessions } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sessions.js')).href)
  const agents = new Map()
  const make = id => {
    const agent = { id, ctx: { effect: () => () => {} } }
    agents.set(id, agent)
    return agent
  }
  const first = make('session-attach-one')
  const second = make('session-attach-two')
  const ctx = { get: name => (name === 'agents' ? { get: id => agents.get(id) } : undefined) }
  const sessions = new Sessions(ctx, {
    mode: 'attach',
    cdpEndpoint: 'ws://127.0.0.1:9/devtools/browser/none',
    pythonPath: '/nonexistent/python',
    requestTimeoutMs: 1000,
  })

  const attempt = agent => sessions.run(agent, undefined, async () => 'opened').then(() => '', error => String(error.message))
  const firstFailure = await attempt(first)
  check(/not ready|not usable/u.test(firstFailure), 'the first Session takes the attached browser and reaches the engine check')

  const secondFailure = await attempt(second)
  check(/attached by another live Session/u.test(secondFailure), 'a second Session is refused the attached browser')
  check(!/not usable/u.test(secondFailure), 'the refusal explains the reservation instead of the engine')
  console.log(`PASS: 2 attach-exclusivity checks; no browser, no engine`)
}

/**
 * Attach mode without an endpoint drives the Chrome you browse with. The profile accepts it, and every
 * message about the attached browser names that browser instead of an empty endpoint.
 */
async function attachToYourChrome() {
  const { ctx, tools, agent } = fakeContext()
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  plugin.apply(ctx, { pythonPath: '/nonexistent/python', projectPath: '', mode: 'attach' })
  const doctor = await tools.get('browser_doctor').execute({}, { agent, signal: new AbortController().signal })
  check(/mode attach on your running Chrome/u.test(doctor.text), 'the doctor names your running Chrome as the attached browser')

  let refused
  try {
    plugin.apply(fakeContext().ctx, { pythonPath: '/nonexistent/python', mode: 'borrow' })
  } catch (error) {
    refused = String(error.message)
  }
  check(/mode must be "launch" or "attach"/u.test(refused ?? ''), 'an unknown mode is refused when the profile loads')

  const { Sessions } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sessions.js')).href)
  const agents = new Map()
  const make = id => {
    const owner = { id, ctx: { effect: () => () => {} } }
    agents.set(id, owner)
    return owner
  }
  const sessions = new Sessions(
    { get: name => (name === 'agents' ? { get: id => agents.get(id) } : undefined) },
    { mode: 'attach', cdpEndpoint: '', pythonPath: '/nonexistent/python', requestTimeoutMs: 1000 },
  )
  const attempt = owner => sessions.run(owner, undefined, async () => 'opened').then(() => '', error => String(error.message))
  await attempt(make('session-yours-one'))
  const second = await attempt(make('session-yours-two'))
  check(/your running Chrome .* is attached by another live Session/u.test(second),
    'a second Session is refused your running Chrome by name')
  console.log('PASS: 3 attach-to-your-Chrome checks; no browser, no engine')
}

/**
 * Attach mode is checked before the first browser call, and the check is the answer that call would
 * get: an endpoint is asked the way the engine asks it, and the browser you browse with is asked
 * through the engine that would find it. The doctor must not call itself ready while the browser it
 * was told to drive is not there, and the fix has to arrive when the mode is chosen rather than on
 * the first failed browser call.
 *
 * The engine is stubbed here rather than installed: what is under test is the check, and a stub is
 * the only way to ask for "no browser found" on a machine that has one.
 */
async function attachPreflight() {
  const engine = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'engine.js')).href)
  let count = 0
  const ok = (condition, message) => { check(condition, message); count += 1 }
  const absent = { pythonPath: '/nonexistent/python', projectPath: '' }

  const devtools = createHttpServer((request, response) => {
    if (request.url !== '/json/version') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ Browser: 'Chrome/140.0.7390.55', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/abc' }))
  })
  await new Promise(resolve => devtools.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = `http://127.0.0.1:${devtools.address().port}`
    const live = await engine.inspectEngine({ ...absent, mode: 'attach', cdpEndpoint: endpoint }, { fresh: true })
    ok(live.attach?.reachable === true, 'an endpoint that answers /json/version counts as reachable')
    ok(live.attach.detail.includes('Chrome/140.0.7390.55'), 'the check names the browser the endpoint says it is')
    ok(live.problems.every(item => item.code !== 'attach_unreachable'), 'an endpoint that answers is not reported as a problem')
  } finally {
    await new Promise(resolve => devtools.close(resolve))
  }

  const dead = await engine.inspectEngine({ ...absent, mode: 'attach', cdpEndpoint: 'http://127.0.0.1:1' }, { fresh: true })
  ok(dead.ok === false && dead.attach?.reachable === false, 'an endpoint nothing answers fails the report instead of reading as ready')
  const deadText = engine.reportText(dead)
  ok(deadText.includes('http://127.0.0.1:1') && /fix:/u.test(deadText), 'the doctor names the endpoint and what to do about it')
  ok(!/Status\s*:\s*ready/u.test(deadText), 'the doctor does not say ready while the browser it was told to drive is absent')

  const tcp = createTcpServer(socket => socket.destroy())
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  try {
    const ws = await engine.inspectEngine(
      { ...absent, mode: 'attach', cdpEndpoint: `ws://127.0.0.1:${tcp.address().port}/devtools/browser/x` }, { fresh: true })
    ok(ws.attach?.reachable === true, 'a ws endpoint with something listening counts as reachable')
  } finally {
    await new Promise(resolve => tcp.close(resolve))
  }
  const wsDead = await engine.inspectEngine({ ...absent, mode: 'attach', cdpEndpoint: 'ws://127.0.0.1:1/devtools/browser/x' }, { fresh: true })
  ok(wsDead.attach?.reachable === false && /nothing is listening/u.test(engine.reportText(wsDead)), 'a ws endpoint nothing listens at says so')

  // An interpreter that answers the engine probe and then refuses the attach probe, so the answer
  // the engine gives for "no browser found" is exercised without depending on this machine's browser.
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-browser-use-attach-'))
  try {
    const answerPath = join(scratch, 'answer.json')
    const program = join(scratch, 'stub.cjs')
    await writeFile(program, [
      'const fs = require("node:fs")',
      'const asked = process.argv.slice(2).join("\u0000")',
      'const engine = { python: "3.12.14", engine: "0.1.0", enginePath: "/tmp/engine", browserHarness: "0.1.13" }',
      `process.stdout.write(JSON.stringify(asked.includes("discover_local_browser")`
        + ` ? JSON.parse(fs.readFileSync(${JSON.stringify(answerPath)}, "utf8")) : engine))`,
      '',
    ].join('\n'))
    const python = join(scratch, 'python')
    await writeFile(python, `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`, { mode: 0o755 })

    await writeFile(answerPath, JSON.stringify({ kind: 'no_browser', message: 'No running browser has remote debugging turned on.' }))
    const noBrowser = await engine.inspectEngine({ pythonPath: python, mode: 'attach' }, { fresh: true })
    ok(noBrowser.ok === false && noBrowser.problems.some(item => item.code === 'no_browser'),
      'a browser you browse with that cannot be found is a problem, not a note nobody reads')
    ok(noBrowser.attach.detail.includes('not found') && /remote debugging turned on/u.test(noBrowser.attach.message),
      'the doctor keeps the engine\u2019s own words about the browser it could not find')
    ok(/mode to "launch"/u.test(noBrowser.attach.fix), 'the fix offers the mode that needs no browser of yours')

    await writeFile(answerPath, JSON.stringify({ kind: 'no_permission', message: 'This process may not read the profile.' }))
    const noPermission = await engine.inspectEngine({ pythonPath: python, mode: 'attach' }, { fresh: true })
    ok(noPermission.problems.some(item => item.code === 'no_permission'),
      'a profile the process may not read is reported under its own code')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const unchecked = await engine.inspectEngine({ ...absent, mode: 'attach' }, { fresh: true })
  ok(unchecked.attach?.checked === false && /not checked/u.test(unchecked.attach.detail),
    'with no engine the browser you browse with reads as not checked, never as ready')
  ok(unchecked.problems.map(item => item.code).join(',') === 'no_engine',
    'a missing engine is reported once, without inventing an attach problem on top of it')

  const cli = (...args) => spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'doctor.mjs'), ...args], { encoding: 'utf8' })
  const mode = cli('--mode', 'borrow')
  ok(mode.status === 2 && /mode must be "launch" or "attach"/u.test(mode.stderr), 'the command refuses a mode the profile would refuse')
  const url = cli('--mode', 'attach', '--cdp-endpoint', 'not a url')
  ok(url.status === 2 && /cdpEndpoint must be/u.test(url.stderr), 'the command refuses an endpoint the profile would refuse')
  const run = cli('--mode', 'attach', '--cdp-endpoint', 'http://127.0.0.1:1')
  ok(run.status === 1 && run.stdout.includes('http://127.0.0.1:1') && /fix:/u.test(run.stdout) && /Mode\s*:\s*attach/u.test(run.stdout),
    'the command checks the attached browser the way DSH does at load, and exits 1 for it')
  console.log(`PASS: ${count} attach-preflight checks; no browser, no engine`)
}

/**
 * What the Settings page shows and what a live edit does.
 *
 * DSH renders that page from the plugin's exported `Config`: only fields under a volatile node get a
 * form field, and an edit is committed into the reference the running plugin holds instead of
 * recomposing it. Both halves are checked here against the same rules the settings service applies.
 */
async function settingsForm() {
  const config = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'config.js')).href)
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  let count = 0
  const ok = (condition, message) => { check(condition, message); count += 1 }

  ok(plugin.Config === config.Config && Reflect.get(config.Config, Symbol.for('schemastery')) === true
    && config.Config.type === 'object',
  'the plugin exports a native Config schema, which is what the Settings page renders')

  // The settings service keeps a field whose nearest volatile ancestor is marked, and drops the rest.
  const formFields = (schema, prefix = '') => {
    if (schema.meta?.volatile === true) return [prefix]
    return Object.entries(schema.dict ?? {}).flatMap(([key, child]) => formFields(child, prefix === '' ? key : `${prefix}.${key}`))
  }
  const fields = formFields(config.Config).sort()
  ok(JSON.stringify(fields) === JSON.stringify([
    'jev.enabled', 'jev.source',
    'jev.textModel.apiKey', 'jev.textModel.apiKeyEnv', 'jev.textModel.baseURL', 'jev.textModel.model',
    'jev.typesafe.apiKey', 'jev.typesafe.apiKeyEnv', 'jev.typesafe.baseURL', 'jev.typesafe.model',
  ].sort()), `the form offers jev and nothing else (got ${fields.join(', ')})`)
  ok(!fields.includes('mode') && !fields.includes('delegate') && !fields.includes('allowScreenshots')
    && !fields.includes('projectPath') && !fields.includes('reserveBrowserUseSlot'),
  'the switches that decide which tools exist stay profile-patch settings')

  // A live edit: the Loader commits the value into the reference the plugin was handed.
  const { ctx, tools, agent, emit } = fakeContext()
  const parsed = config.Config({
    pythonPath: '/nonexistent/python',
    projectPath: '',
    jev: { enabled: false },
  })
  ok(typeof parsed.jev.enabled?.get === 'function' && config.plain(parsed.jev.enabled) === false,
    'a live field arrives as a reference the plugin can read now')
  plugin.apply(ctx, parsed)
  const doctor = async () => (await tools.get('browser_doctor').execute({}, { agent, signal: new AbortController().signal })).text
  ok(!tools.has('browser_goal'), 'browser_goal is absent until the Settings page turns jev on')
  const actSchema = () => tools.get('browser_act').parameters
  ok(actSchema().properties.intent === undefined && actSchema().required.includes('operation'),
    'with jev off, browser_act takes an operation and offers no intent')

  const LIVE = Symbol.for('cosmokit.volatile.write')
  parsed.jev.enabled[LIVE](true)
  parsed.jev.typesafe.baseURL[LIVE]('https://gateway.test/systemone')
  emit('loader/volatile-update', [['jev', 'enabled'], ['jev', 'typesafe', 'baseURL']])

  ok(tools.has('browser_goal'), 'turning jev on from the plugin form offers browser_goal without a restart')
  ok(actSchema().properties.intent?.type === 'string' && !actSchema().required.includes('operation'),
    'turning jev on lets browser_act take an intent in place of an operation')
  const act = args => tools.get('browser_act').execute(args, { agent, signal: new AbortController().signal })
  ok(/^Refused: Jev cannot run/u.test((await act({ observation: 1, intent: 'Submit the form' })).text),
    'an intent whose Jev credentials cannot be resolved is refused before any browser or model call')
  ok(/^Refused: give an operation/u.test((await act({ observation: 1 })).text),
    'neither an operation nor an intent is refused')
  ok(/^Jev\s*: on, source session/u.test((await doctor()).split('\n').find(line => line.startsWith('Jev')) ?? ''),
    'the doctor reports the edited jev state')
  console.log(`PASS: ${count} settings-form checks; no browser, no engine, no model calls`)
}

/**
 * A cancelled call settles instead of waiting for an answer that may never come, and says what the
 * browser may still do.
 */
async function cancelInFlight() {
  const { Sidecar } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sidecar.js')).href)
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-cancel-'))
  const sidecar = new Sidecar({
    config: {
      projectPath: ENGINE,
      pythonPath: '',
      mode: 'launch',
      cdpEndpoint: '',
      executablePath: '',
      userDataDir: join(profile, 'browser'),
      headless: true,
      requestTimeoutMs: 120000,
    },
    label: 'cancel-check',
  })
  try {
    await sidecar.ready()
    const controller = new AbortController()
    // The address refuses immediately: the call is cancelled before any answer could arrive, and the
    // engine is left with nothing long-running to clean up.
    const pending = sidecar.request('open', { url: 'http://127.0.0.1:1/', mode: 'launch', userDataDir: join(profile, 'browser'), headless: true }, controller.signal)
    controller.abort()
    const started = Date.now()
    const error = await pending.then(() => undefined, failure => failure)
    check(error !== undefined && error.kind === 'cancelled', 'an aborted in-flight call settles as cancelled')
    check(Date.now() - started < 5000, 'the cancelled call settles immediately instead of waiting for the browser')
    check(/read the page again/u.test(String(error.message)), 'the cancellation says what the browser may still do')
  } finally {
    await sidecar.stop()
    await new Promise(resolve => setTimeout(resolve, 1500))
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  console.log('PASS: 3 cancellation checks; real sidecar, no model calls')
}

/** Control state reaches the model: without it, it cannot tell a ticked box from an unticked one. */
async function elementStates() {
  const { pageText } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'tools.js')).href)
  const text = pageText({
    url: 'https://example.test/', title: 'T', operations: { CLICK: ['1', '2', '3'] },
    elements: [
      { index: '1', role: 'checkbox', label: 'Free cancellation', value: 'on', checked: 'true', operations: ['CLICK'] },
      { index: '2', role: 'checkbox', label: 'Pool', value: 'on', checked: 'false', operations: ['CLICK'] },
      { index: '3', role: 'button', label: 'Filters', expanded: 'false', operations: ['CLICK'] },
    ],
  }, 1)
  check(text.includes('[1] checkbox Free cancellation · "on" (checked) — CLICK'), 'a ticked checkbox reads as checked')
  check(text.includes('[2] checkbox Pool · "on" (not checked) — CLICK'), 'an unticked checkbox reads as not checked')
  check(text.includes('[3] button Filters (collapsed) — CLICK'), 'a collapsed disclosure reads as collapsed')
  console.log('PASS: 3 element-state checks; no browser')
}

await elementStates()
await main()
await missingEngine()
await engineConfiguration()
await attachExclusivity()
await attachToYourChrome()
await attachPreflight()
await settingsForm()
await cancelInFlight()

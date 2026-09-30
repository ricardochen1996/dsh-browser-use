/**
 * The delegated half, driven without DSH: a fake Cordis context, a fake `ctx.subagents`, the real
 * sidecar, a real browser.
 *
 * Run with `node test/delegation.mjs`. It checks the arrangement the plugin promises: the
 * conversation holds `browser_task` and nothing else, a delegated child is the only agent that ever
 * sees a browser tool, the persistent subagent takes every later task and comes back after it settles
 * or the process restarts, and the browser it drives outlives any one task.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/** Progress goes to stderr as it happens: a stall names its own phase. */
const phase = message => process.stderr.write(`  … ${message}\n`)

/**
 * The part of Cordis this plugin uses, with one scope per Agent: a global registration, scoped
 * registrations, scoped restrictions, prompt sections, and the `agent/created` event — plus the
 * part of `ctx.subagents` it drives: one-shot runs, and continuable children with a catalog.
 */
function fakeHost({ capabilities = { toolFilter: true }, late = false, continuable = true, control = true } = {}) {
  const globals = new Map()
  const scopes = new Map()
  const restrictions = new Map()
  const sections = []
  const listeners = new Map()
  const agents = new Map()
  const warnings = []
  const delegations = []
  /** Continuable children, in creation order, and each parent's durable catalog. */
  const children = []
  const catalogs = new Map()
  const interrupted = []

  /** Every effect the plugin registered, so unloading it can be driven the way Cordis would. */
  const effects = []
  /** Take a Cordis effect callback: a generator of disposers, or one disposer itself. */
  const effect = callback => {
    const result = callback()
    let dispose
    if (result !== undefined && typeof result.next === 'function') {
      const disposers = []
      let current = result
      while (current.done !== true) {
        if (typeof current.value === 'function') disposers.push(current.value)
        current = result.next()
      }
      dispose = async () => { for (const item of disposers.reverse()) await item() }
    } else {
      dispose = async () => { await (typeof result === 'function' ? result() : undefined) }
    }
    effects.push(dispose)
    return dispose
  }

  const makeAgent = (id, header) => {
    if (!scopes.has(id)) scopes.set(id, new Map())
    if (!restrictions.has(id)) restrictions.set(id, [])
    const agent = { id, session: { header } }
    agent.ctx = {
      tools: {
        register: definition => {
          scopes.get(id).set(definition.name, definition)
          return () => scopes.get(id).delete(definition.name)
        },
        restrict: filter => {
          restrictions.get(id).push(filter)
          return () => {}
        },
      },
      systemPrompt: {
        section: specification => { sections.push({ scope: id, ...specification }); return () => {} },
        getSectionOrder: () => 0,
      },
      effect,
    }
    agents.set(id, agent)
    return agent
  }
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) ?? []) await handler(payload)
  }
  const failure = (message, code) => Object.assign(new Error(message), { code })

  /** A continuable child the host already persisted, with no live Agent: what a restarted process finds. */
  const seedChild = (parentId, label) => {
    const id = `child-c${children.length + 1}`
    const record = { id, parentId, label, request: undefined, messages: [], child: undefined, gone: false, tools: () => scopes.get(id) }
    children.push(record)
    if (!catalogs.has(parentId)) catalogs.set(parentId, [])
    catalogs.get(parentId).push({ id, mode: 'continuable', label, createdAt: Date.now() })
    return record
  }
  /** The continuation manager disposes a child's handle once it goes idle: its scope goes with it. */
  const settle = record => {
    scopes.get(record.id)?.clear()
    restrictions.set(record.id, [])
    agents.delete(record.id)
    record.child = undefined
  }

  const provider = {
    name: 'spawn',
    capabilities,
    inheritsParentContext: false,
    ...continuable ? { prepareContinuable: async () => ({}) } : {},
  }
  const subagents = {
    getProvider: name => (name === 'spawn' ? provider : undefined),
    start: async (_name, request) => {
      const child = makeAgent(`child-${delegations.length + 1}`, {
        parentSession: request.parent.id,
        origin: 'subagent',
        isSeeded: false,
      })
      await emit('agent/created', { agent: child, source: 'startup' })
      let deliver
      const delivered = new Promise(resolve => { deliver = resolve })
      const record = { child, request, disposed: false, deliver, tools: scopes.get(child.id) }
      delegations.push(record)
      // The in-process provider cancels a published run's remaining work when the request signal
      // fires; the fake settles the same way, so the plugin cannot pass by ignoring the signal.
      request.signal?.addEventListener('abort', () => deliver('(the run was cancelled)'), { once: true })
      return {
        id: child.id,
        localAgent: child,
        result: (async () => {
          const text = await delivered
          return {
            output: [{ type: 'text', text }],
            stopReason: request.signal.aborted ? 'aborted' : 'completed',
          }
        })(),
        dispose: async () => {
          record.disposed = true
          agents.delete(child.id)
        },
      }
    },
    ...continuable
      ? {
          startContinuable: async spec => {
            spec.signal.throwIfAborted()
            const record = seedChild(spec.request.parent.id, spec.label)
            record.request = spec.request
            record.child = makeAgent(record.id, { parentSession: spec.request.parent.id, origin: 'subagent', isSeeded: false })
            await emit('agent/created', { agent: record.child, source: 'startup' })
            record.messages.push(spec.request.prompt)
            return { childId: record.id, messageId: `m-${record.id}-1` }
          },
          sendMessage: async (sender, targetId, content, options) => {
            options.signal.throwIfAborted()
            const record = children.find(item => item.id === targetId && item.parentId === sender.id)
            if (record === undefined) throw failure(`"${targetId}" is not a direct child`, 'UNAUTHORIZED')
            if (record.gone) throw failure(`subagent "${targetId}" is unavailable`, 'NOT_RESUMABLE')
            if (record.child === undefined) {
              // An absent child cold-resumes from persistence before it takes the message.
              record.child = makeAgent(record.id, { parentSession: record.parentId, origin: 'subagent', isSeeded: false })
              await emit('agent/created', { agent: record.child, source: 'resume' })
            }
            record.messages.push(content)
            return `m-${record.id}-${record.messages.length}`
          },
          listChildren: async parentId => [...catalogs.get(parentId) ?? []],
          interrupt: targetId => { interrupted.push(targetId) },
        }
      : {},
  }

  // A service that activates asynchronously is absent while a plugin applies: `late` is the
  // composition this plugin actually meets in DSH.
  let service = late ? undefined : subagents

  const ctx = {
    tools: {
      register: definition => { globals.set(definition.name, definition); return () => globals.delete(definition.name) },
      get: name => globals.get(name),
      schemas: () => [...globals.values()],
    },
    agents: { get: id => agents.get(id) },
    systemPrompt: {
      section: specification => { sections.push({ scope: 'global', ...specification }); return () => {} },
      getSectionOrder: () => 0,
    },
    logger: { info: () => {}, warn: message => warnings.push(String(message)) },
    get: name => (name === 'agents' ? ctx.agents : name === 'subagents' ? service : undefined),
    effect,
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler))
    },
  }
  // The base bundle's subagent-control tools, which a persistent child needs to talk back.
  if (control) {
    for (const name of ['send_message', 'interrupt_agent']) globals.set(name, { name, external: true })
  }

  const conversation = makeAgent('session-conversation', { isSeeded: false })
  const dispose = async () => { for (const item of effects.reverse()) await item() }
  const provide = async () => {
    service = subagents
    await emit('subagent/provider-added', { name: 'spawn', capabilities, inheritsParentContext: false })
  }
  const unprovide = async () => {
    service = undefined
    await emit('subagent/provider-removed', 'spawn')
  }
  /** The tools this plugin registered for every agent. */
  const own = () => [...globals.values()].filter(item => item.external !== true).map(item => item.name).sort().join(',')
  return {
    ctx, conversation, globals, scopes, restrictions, sections, delegations, children, interrupted, warnings,
    dispose, provide, unprovide, settle, seedChild, subagents, own,
  }
}

/** Wait until the fake subagents service has created the given one-shot delegation. */
async function waitForChild(host, index = 0) {
  const deadline = Date.now() + 10000
  while (host.delegations.length <= index) {
    if (Date.now() > deadline) throw new Error(`no delegation was created (have ${host.delegations.length}, want ${index + 1})`)
    await wait(10)
  }
  return host.delegations[index]
}

const BROWSER_TOOLS = 'browser_act,browser_close,browser_console,browser_open,browser_page,browser_screenshot'
const textOf = content => content.map(block => block.text).join('\n')

/** The default composition: one persistent browser subagent per conversation, on a real browser. */
async function persistentChecks(plugin) {
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-delegation-'))
  const host = fakeHost()
  plugin.apply(host.ctx, { projectPath: ENGINE, userDataDir: join(profile, 'browser'), headless: true })

  const ask = (args, signal = new AbortController().signal) =>
    host.globals.get('browser_task').execute(args, { agent: host.conversation, signal })
  const childCall = (record, name, args) =>
    record.tools().get(name).execute(args ?? {}, { agent: record.child, signal: new AbortController().signal })

  try {
    check(host.own() === 'browser_doctor,browser_task', `the conversation holds ${host.own()}`)
    check(!host.globals.has('browser_open') && !host.globals.has('browser_act'),
      'no browser tool is registered for every agent')
    check(host.globals.get('browser_task').parameters.properties.fresh?.type === 'boolean',
      'browser_task can ask for a fresh subagent')
    check(host.sections.some(item => item.scope === 'global' && item.text.includes('persistent browser subagent')),
      'the conversation is told the browser subagent persists and reports by message')

    // First task: the subagent is started, and the call returns without waiting for its work.
    phase('first task starts the persistent subagent')
    const first = await ask({ instruction: 'Open the page and type Lisbon into Destination.', url: FIXTURE })
    check(host.children.length === 1, 'the first task starts one continuable child')
    const record = host.children[0]
    check(first.text.includes('Started') && first.text.includes(record.id),
      'browser_task returns at once and names the subagent')
    check(record.label === 'browser-task', 'the child carries the browser label the plugin finds it by')
    check(host.own() === 'browser_doctor,browser_task', 'the conversation still holds no browser tool')
    check([...record.tools().keys()].sort().join(',') === BROWSER_TOOLS, `the child holds ${[...record.tools().keys()].join(', ')}`)
    check(JSON.stringify(record.request.toolFilter) === '{"allow":["send_message"]}'
      && JSON.stringify(host.restrictions.get(record.id)) === '[{"allow":["send_message"]}]',
      'the child sees its browser tools and send_message back to its parent, nothing else')
    check(textOf(record.messages[0]).includes('send_message') && textOf(record.messages[0]).includes('persistent browser agent'),
      'the child is told it persists and reports with send_message')
    check(host.sections.some(item => item.scope === record.id && item.name === 'dsh-browser-use:browser'),
      'the child gets the browser guidance')
    check(!host.sections.some(item => item.scope === 'global' && item.name.startsWith('dsh-browser-use:browser')),
      'the conversation does not get the child guidance')

    phase('child opens the page')
    const opened = await childCall(record, 'browser_open', { url: FIXTURE })
    const target = opened.text.match(/\[(\d+)\][^\n]*searchbox Destination/u)?.[1]
    check(target !== undefined, 'the child reads an indexed action space from the real browser')
    const typed = await childCall(record, 'browser_act', { observation: opened.observation, operation: 'TYPE_TEXT', target, text: 'Lisbon' })
    check(typed.text.includes('· "Lisbon"'), 'the child acts on the page')

    // The child finishes its turn and settles; its handle is disposed, its conversation is not.
    host.settle(record)
    check(record.tools().size === 0, 'a settled child holds no live tools')

    phase('second task goes to the same subagent')
    const second = await ask({ instruction: 'Read the page again and report the destination field.' })
    check(host.children.length === 1, 'a second task does not start another child')
    check(second.text.includes('Handed') && second.text.includes(record.id), 'the second task is handed to the same subagent')
    check(record.messages.length === 2 && textOf(record.messages[1]).includes('New browser task'),
      'the second task arrives as a message in the child conversation')
    check([...record.tools().keys()].sort().join(',') === BROWSER_TOOLS
      && JSON.stringify(host.restrictions.get(record.id)) === '[{"allow":["send_message"]}]',
      'a resumed child gets its browser tools back')
    phase('resumed child reads the page again')
    const page = await childCall(record, 'browser_page', {})
    check(page.text.includes('· "Lisbon"'), 'the resumed child drives the same browser, on the page it left')

    phase('doctor')
    const doctor = await host.globals.get('browser_doctor').execute({}, { agent: host.conversation, signal: new AbortController().signal })
    check(/Delegation\s*:\s*on: persistent/.test(doctor.text) && doctor.text.includes(record.id),
      'the doctor reports the persistent subagent of this conversation')

    phase('fresh subagent')
    const fresh = await ask({ instruction: 'Start over.', fresh: true })
    check(host.children.length === 2 && fresh.text.includes('Started') && fresh.text.includes(host.children[1].id),
      'fresh: true starts a new subagent')
    check(host.interrupted.includes(record.id), 'the subagent being replaced is stopped, so two never drive one browser')
    const afterFresh = await ask({ instruction: 'Continue.' })
    check(afterFresh.text.includes(host.children[1].id) && host.children[1].messages.length === 2,
      'later tasks go to the new subagent')

    phase('lost subagent')
    host.children[1].gone = true
    host.settle(host.children[1])
    const replaced = await ask({ instruction: 'Continue again.' })
    check(host.children.length === 3 && replaced.text.includes('Started'),
      'a subagent that cannot be resumed is replaced instead of failing the task')
  } finally {
    // Unloading the plugin closes the Session browser: the conversation's browser goes with the
    // conversation, not with the subagent that happened to use it.
    await host.dispose()
    await wait(1500)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

/** A restarted process has no memory of the browser subagent: it finds it in the parent's catalog. */
async function restartChecks(plugin) {
  const host = fakeHost()
  const seeded = host.seedChild(host.conversation.id, 'browser-task')
  const other = host.seedChild(host.conversation.id, 'code-review')
  plugin.apply(host.ctx, { projectPath: ENGINE })

  phase('restart: resumed by send_message')
  await host.subagents.sendMessage(host.conversation, seeded.id, [{ type: 'text', text: 'Anything new?' }], { signal: new AbortController().signal })
  check([...seeded.tools().keys()].sort().join(',') === BROWSER_TOOLS,
    'a browser subagent resumed by send_message after a restart gets its browser tools')
  await host.subagents.sendMessage(host.conversation, other.id, [{ type: 'text', text: 'Hi' }], { signal: new AbortController().signal })
  check(other.tools().size === 0 && host.restrictions.get(other.id).length === 0,
    'a different subagent of the same conversation is left alone')

  phase('restart: browser_task')
  host.settle(seeded)
  const text = (await host.globals.get('browser_task').execute({ instruction: 'Next.' }, {
    agent: host.conversation,
    signal: new AbortController().signal,
  })).text
  check(host.children.length === 2 && text.includes('Handed') && text.includes(seeded.id),
    'browser_task after a restart continues the subagent the catalog records')
  check([...seeded.tools().keys()].sort().join(',') === BROWSER_TOOLS, 'and that subagent drives the browser again')
  await host.dispose()
}

/** A provider that cannot continue a child, or `delegateMode: one-shot`: one child per task. */
async function oneShotChecks(plugin) {
  const host = fakeHost({ continuable: false })
  plugin.apply(host.ctx, { projectPath: ENGINE })
  const ask = (args, signal = new AbortController().signal) =>
    host.globals.get('browser_task').execute(args, { agent: host.conversation, signal })

  check(host.globals.get('browser_task').parameters.properties.fresh === undefined,
    'a one-shot browser_task has no fresh option')
  phase('one-shot delegation')
  const pending = ask({ instruction: 'Read the title.' })
  const first = await waitForChild(host, 0)
  check([...first.tools.keys()].sort().join(',') === BROWSER_TOOLS, 'the one-shot child holds the browser tools')
  check(JSON.stringify(host.restrictions.get(first.child.id)) === '[{"allow":[]}]',
    'the one-shot child runs with an empty global allow-list')
  first.deliver('The title is Fixture.')
  const report = await pending
  check(report.text.includes('The title is Fixture.'), 'a one-shot delegation waits for and returns the child report')
  check(first.disposed, 'a one-shot delegation gives the child back')

  phase('cancelled one-shot delegation')
  const controller = new AbortController()
  const cancelled = ask({ instruction: 'Wait forever.' }, controller.signal)
  const second = await waitForChild(host, 1)
  controller.abort()
  let refusal
  try { await cancelled } catch (error) { refusal = String(error?.message ?? error) }
  check(refusal !== undefined, 'a cancelled delegation settles the tool call instead of hanging')
  check(second.disposed, 'a cancelled delegation gives the child back too')

  const doctor = await host.globals.get('browser_doctor').execute({}, { agent: host.conversation, signal: new AbortController().signal })
  check(/Delegation\s*:\s*on: one-shot/.test(doctor.text), 'the doctor reports one-shot delegation')
  await host.dispose()

  const configured = fakeHost()
  plugin.apply(configured.ctx, { projectPath: ENGINE, delegateMode: 'one-shot' })
  const configuredPending = configured.globals.get('browser_task').execute({ instruction: 'x' }, {
    agent: configured.conversation,
    signal: new AbortController().signal,
  })
  const child = await waitForChild(configured, 0)
  child.deliver('done')
  await configuredPending
  check(configured.children.length === 0, 'delegateMode "one-shot" keeps one-shot children on a continuable host')
  await configured.dispose()
}

async function main() {
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  await persistentChecks(plugin)
  await restartChecks(plugin)
  await oneShotChecks(plugin)

  // The provider composes an in-process child because it can restrict the child's tools; without
  // that capability the plugin does not pretend to delegate.
  phase('fallback host')
  const fallback = fakeHost({ capabilities: { toolFilter: false } })
  plugin.apply(fallback.ctx, { projectPath: ENGINE })
  check(!fallback.globals.has('browser_task'), 'an unusable provider leaves no delegation tool behind')
  check(fallback.globals.has('browser_open'), 'an unusable provider falls back to the browser tools')
  check(fallback.warnings.some(message => message.includes('not delegated')), 'the fallback is reported at load')
  await fallback.dispose()

  // `ctx.subagents` activates asynchronously, so the plugin usually applies before it exists: the
  // composition has to be read again when the provider arrives, not decided once at load.
  phase('late provider')
  const late = fakeHost({ late: true })
  plugin.apply(late.ctx, { projectPath: ENGINE })
  check(late.globals.has('browser_open') && !late.globals.has('browser_task'),
    'a composition without the subagent service starts in direct mode')
  await late.provide()
  check(late.globals.has('browser_task') && !late.globals.has('browser_open'),
    'a provider that appears later turns delegation on and takes the browser tools away')
  await late.unprovide()
  check(late.globals.has('browser_open') && !late.globals.has('browser_task'),
    'a provider that goes away falls back to the browser tools')
  await late.dispose()

  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} delegation checks; real browser, no model calls`)
}

await main()

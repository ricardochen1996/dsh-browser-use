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
  /** Events DSH publishes synchronously, from inside a step that must not be split. */
  const emitNow = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) handler(payload)
  }
  const failure = (message, code) => Object.assign(new Error(message), { code })
  /** What a continuation manager publishes when a child's Activation becomes resident. */
  const lifecycle = record => ({ runId: `run-${record.id}-${record.messages.length + 1}`, provider: 'spawn', id: record.id, local: true })
  /** Put one message in an Agent's inbox, the way DSH announces it. */
  const deliver = (agent, text, source) => emitNow('agent/inbox/inserted', {
    agent,
    message: { role: 'user', content: [{ type: 'text', text }], source },
  })

  /** A continuable child the host already persisted, with no live Agent: what a restarted process finds. */
  const seedChild = (parentId, label) => {
    const id = `child-c${children.length + 1}`
    const record = { id, parentId, label, request: undefined, messages: [], child: undefined, gone: false, tools: () => scopes.get(id) }
    children.push(record)
    if (!catalogs.has(parentId)) catalogs.set(parentId, [])
    catalogs.get(parentId).push({ id, mode: 'continuable', label, createdAt: Date.now() })
    return record
  }
  /**
   * The continuation manager disposes a child's handle once it goes idle: its scope goes with it.
   * Then, in one synchronous step, it tells the parent (the settlement notice) and publishes
   * `subagent/end` — unless `notify` is false, which is a child that vanished without either.
   */
  const settle = (record, { stopReason = 'completed', text, notify = true } = {}) => {
    scopes.get(record.id)?.clear()
    restrictions.set(record.id, [])
    agents.delete(record.id)
    record.child = undefined
    if (!notify) return
    const parent = agents.get(record.parentId)
    if (parent !== undefined) {
      const summary = `Background subagent ${record.id} finished and will do no further work unless you send it more.`
      deliver(parent, `${summary}\n\n${text === undefined ? 'It left no closing message.' : `Its closing message:\n${text}`}`, {
        kind: 'subagent-settled', form: 'notice', summary, senderSessionId: record.id,
      })
    }
    emitNow('subagent/end', {
      ...lifecycle(record),
      stopReason,
      ...(text === undefined ? {} : { lastAssistantMessage: [{ type: 'text', text }] }),
    })
  }
  /** The user types into the conversation. */
  const userWrites = text => deliver(conversation, text, { kind: 'user' })
  /** A child uses `send_message` to its parent. */
  const relay = (record, text) => deliver(agents.get(record.parentId), text, {
    kind: 'agent-message', form: 'relay', senderSessionId: record.id,
  })

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
            await emit('subagent/start', lifecycle(record))
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
              await emit('subagent/start', lifecycle(record))
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
    dispose, provide, unprovide, settle, seedChild, subagents, own, userWrites, relay,
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
  const status = (args = {}, signal = new AbortController().signal) =>
    host.globals.get('browser_task_status').execute(args, { agent: host.conversation, signal })
  const childCall = (record, name, args) =>
    record.tools().get(name).execute(args ?? {}, { agent: record.child, signal: new AbortController().signal })

  try {
    check(host.own() === 'browser_doctor,browser_task,browser_task_status', `the conversation holds ${host.own()}`)
    check(!host.globals.has('browser_open') && !host.globals.has('browser_act'),
      'no browser tool is registered for every agent')
    check(host.globals.get('browser_task').parameters.properties.fresh?.type === 'boolean',
      'browser_task can ask for a fresh subagent')
    const statusParameters = host.globals.get('browser_task_status').parameters.properties
    check(statusParameters.wait?.type === 'boolean' && statusParameters.timeout_ms?.type === 'number',
      'browser_task_status can report at once or wait with a timeout')
    const guidance = host.sections.find(item => item.scope === 'global' && item.name === 'dsh-browser-use')?.text ?? ''
    check(guidance.includes('persistent browser subagent'),
      'the conversation is told the browser subagent persists and reports by message')
    check(guidance.includes('You are notified when it finishes') && guidance.includes('never sleep')
      && guidance.includes('browser_task_status'),
      'the conversation is told it is notified, must not sleep, and can check with browser_task_status')
    check((await status()).text.includes('No browser subagent works for this conversation yet'),
      'browser_task_status before the first task says there is no subagent yet')

    // First task: the subagent is started, and the call returns without waiting for its work. An
    // agent team in the same conversation has its own wait tools, which never see this subagent.
    host.globals.set('wait_agent', { name: 'wait_agent', external: true })
    phase('first task starts the persistent subagent')
    const first = await ask({ instruction: 'Open the page and type Lisbon into Destination.', url: FIXTURE })
    host.globals.delete('wait_agent')
    check(host.children.length === 1, 'the first task starts one continuable child')
    const record = host.children[0]
    check(first.text.includes('Started') && first.text.includes(record.id),
      'browser_task returns at once and names the subagent')
    check(first.text.includes('You are notified when it finishes') && first.text.includes('Do not sleep')
      && first.text.includes('browser_task_status') && !first.text.includes('wait for it'),
      'the receipt says the result is announced, not to sleep, and how to check — never "wait for it"')
    check(first.text.includes('Agent-team tools (wait_agent) do not see this subagent'),
      'the receipt says the agent-team wait tools do not track the browser subagent')
    check(record.label === 'browser-task', 'the child carries the browser label the plugin finds it by')
    check(host.own() === 'browser_doctor,browser_task,browser_task_status', 'the conversation still holds no browser tool')
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

    phase('status while the subagent works')
    const working = (await status()).text
    check(working.includes(`browser subagent "${record.id}" is working`) && working.includes('Open the page and type Lisbon'),
      'browser_task_status reports the subagent working, and on which task')
    check(working.includes('has not read a page yet') && working.includes('do not sleep or poll'),
      'it says the browser has no page yet, and that the result is announced rather than polled for')

    phase('child opens the page')
    const opened = await childCall(record, 'browser_open', { url: FIXTURE })
    const target = opened.text.match(/\[(\d+)\][^\n]*searchbox Destination/u)?.[1]
    check(target !== undefined, 'the child reads an indexed action space from the real browser')
    const typed = await childCall(record, 'browser_act', { observation: opened.observation, operation: 'TYPE_TEXT', target, text: 'Lisbon' })
    check(typed.text.includes('· "Lisbon"'), 'the child acts on the page')
    check((await status()).text.includes('fixture.html') && (await status()).text.includes('last action'),
      'browser_task_status shows the page the subagent\'s browser is on')

    // The child finishes its turn and settles; its handle is disposed, its conversation is not.
    phase('a wait ends when the subagent finishes')
    const waiting = status({ wait: true, timeout_ms: 60000 })
    await wait(50)
    const settledAt = Date.now()
    host.settle(record, { text: 'Destination now reads Lisbon.' })
    check(record.tools().size === 0, 'a settled child holds no live tools')
    const finished = (await waiting).text
    check(Date.now() - settledAt < 1000, `a wait returns as soon as the subagent settles (${Date.now() - settledAt}ms)`)
    check(finished.includes(`browser subagent "${record.id}" finished`) && finished.includes('follows this result'),
      'the wait says the subagent finished and that its report follows as a message')

    phase('status of an idle subagent')
    const idle = (await status()).text
    check(idle.includes('is idle') && idle.includes('completed') && idle.includes('Destination now reads Lisbon.'),
      'browser_task_status reports an idle subagent, how its last run ended, and its closing message')
    check((await status({ wait: true })).text.startsWith('Nothing to wait for'),
      'waiting on an idle subagent returns at once')

    phase('second task goes to the same subagent')
    const second = await ask({ instruction: 'Read the page again and report the destination field.' })
    check(host.children.length === 1, 'a second task does not start another child')
    check(second.text.includes('Handed') && second.text.includes(record.id), 'the second task is handed to the same subagent')
    check(!second.text.includes('Agent-team tools'), 'the receipt names agent-team tools only where they exist')
    check(record.messages.length === 2 && textOf(record.messages[1]).includes('New browser task'),
      'the second task arrives as a message in the child conversation')
    check([...record.tools().keys()].sort().join(',') === BROWSER_TOOLS
      && JSON.stringify(host.restrictions.get(record.id)) === '[{"allow":["send_message"]}]',
      'a resumed child gets its browser tools back')
    check((await status()).text.includes('Read the page again'), 'browser_task_status follows the resumed subagent to its new task')
    phase('resumed child reads the page again')
    const page = await childCall(record, 'browser_page', {})
    check(page.text.includes('· "Lisbon"'), 'the resumed child drives the same browser, on the page it left')

    phase('a wait that times out, one the user ends, one the subagent ends by writing, one cancelled')
    const timedOut = (await status({ wait: true, timeout_ms: 1 })).text
    // Clamped up to the 1s floor; a busy runner may round a late timer to 2s, but never down to 0s.
    check(/Waited [12]s/.test(timedOut) && timedOut.includes('still working'),
      'a wait clamped to its shortest timeout returns with the subagent still working')
    const userWait = status({ wait: true })
    await wait(50)
    host.userWrites('Also check the dates.')
    const byUser = (await userWait).text
    check(byUser.includes('the user sent a message') && byUser.includes('still working'),
      'a message from the user ends the wait')
    const messageWait = status({ wait: true })
    await wait(50)
    host.relay(record, 'Question: which dates?')
    const byMessage = (await messageWait).text
    check(byMessage.includes('sent you a message') && byMessage.includes('still working'),
      'a message from the subagent ends the wait')
    const controller = new AbortController()
    const cancelledWait = status({ wait: true }, controller.signal)
    await wait(50)
    controller.abort()
    let cancelled
    try { await cancelledWait } catch (error) { cancelled = error }
    check(cancelled !== undefined, 'a cancelled wait settles the tool call instead of hanging')

    phase('doctor')
    const doctor = await host.globals.get('browser_doctor').execute({}, { agent: host.conversation, signal: new AbortController().signal })
    check(/Delegation\s*:\s*on: persistent/.test(doctor.text) && doctor.text.includes(record.id),
      'the doctor reports the persistent subagent of this conversation')
    check(doctor.text.includes(`${record.id}, working for`), 'the doctor says whether that subagent is working')

    phase('fresh subagent')
    const fresh = await ask({ instruction: 'Start over.', fresh: true })
    check(host.children.length === 2 && fresh.text.includes('Started') && fresh.text.includes(host.children[1].id),
      'fresh: true starts a new subagent')
    check(host.interrupted.includes(record.id), 'the subagent being replaced is stopped, so two never drive one browser')
    const afterFresh = await ask({ instruction: 'Continue.' })
    check(afterFresh.text.includes(host.children[1].id) && host.children[1].messages.length === 2,
      'later tasks go to the new subagent')
    check((await status()).text.includes(`browser subagent "${host.children[1].id}" is working`),
      'browser_task_status reports the new subagent')

    // A child that leaves without a notice or an end edge still ends a wait: its liveness is read too.
    phase('a wait outlives a subagent that vanishes silently')
    const silentWait = status({ wait: true })
    await wait(50)
    host.settle(host.children[1], { notify: false })
    const vanished = (await silentWait).text
    check(vanished.includes('finished') && vanished.includes('arrives as a message'),
      'a wait ends when the subagent is gone even if no settlement edge arrived')

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
  const status = args => host.globals.get('browser_task_status').execute(args ?? {}, {
    agent: host.conversation,
    signal: new AbortController().signal,
  })

  phase('restart: status from the catalog')
  const found = (await status()).text
  check(found.includes(`browser subagent "${seeded.id}" is idle`),
    'browser_task_status after a restart finds the subagent in the catalog and reports it idle')

  phase('restart: resumed by send_message')
  await host.subagents.sendMessage(host.conversation, seeded.id, [{ type: 'text', text: 'Anything new?' }], { signal: new AbortController().signal })
  check([...seeded.tools().keys()].sort().join(',') === BROWSER_TOOLS,
    'a browser subagent resumed by send_message after a restart gets its browser tools')
  check((await status()).text.includes(`browser subagent "${seeded.id}" is working`),
    'a subagent resumed by send_message after a restart reports working')
  await host.subagents.sendMessage(host.conversation, other.id, [{ type: 'text', text: 'Hi' }], { signal: new AbortController().signal })
  check(other.tools().size === 0 && host.restrictions.get(other.id).length === 0,
    'a different subagent of the same conversation is left alone')

  phase('restart: browser_task')
  host.settle(seeded)
  const settled = (await status()).text
  check(settled.includes('is idle') && settled.includes('Its last run ended') && settled.includes('completed'),
    'a restarted plugin follows the resumed subagent through its settlement')
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
  check(!host.globals.has('browser_task_status'),
    'a one-shot browser_task answers with the report itself, so there is no status tool')
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
  check(late.globals.has('browser_task') && late.globals.has('browser_task_status') && !late.globals.has('browser_open'),
    'a provider that appears later turns delegation on and takes the browser tools away')
  await late.unprovide()
  check(late.globals.has('browser_open') && !late.globals.has('browser_task') && !late.globals.has('browser_task_status'),
    'a provider that goes away falls back to the browser tools')
  await late.dispose()

  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} delegation checks; real browser, no model calls`)
}

await main()

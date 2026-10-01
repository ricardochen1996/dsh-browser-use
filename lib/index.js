/**
 * Jev Ultrafast as a DeepSeek Harness browser provider.
 *
 * The browser loop, the freshness guards, and the TypeSafe policy stay in the Python sidecar: this
 * half starts one sidecar per Session, speaks line-delimited JSON to it, and renders what it
 * returns.
 *
 * Browser work has two shapes, and the plugin prefers the first:
 *
 * - **Delegated** (default): the conversation gets `browser_task` and `browser_doctor` only. The
 *   browser tools are mounted inside a subagent started through `ctx.subagents`, so the
 *   conversation asks for an outcome instead of reading page tables it will never act on. With a
 *   provider that can continue a child, that subagent is *persistent*: one per conversation, handed
 *   every later task, talking back with `send_message`. Otherwise each task gets a one-shot child.
 * - **Direct**: without a usable subagent provider, or with `delegate: false`, the browser tools
 *   are mounted in the composition and the conversation calls them itself.
 *
 * Either way the browser belongs to the *conversation*: a delegated child drives the browser its
 * Session already owns, and the browser outlives the delegation that used it.
 *
 * The exported `Config` is what makes the switches visible in the Settings page: fields marked live
 * there (`lib/config.js`) are editable while this plugin runs, and a live edit arrives as
 * `loader/volatile-update` rather than as a recomposition.
 *
 * @module @weichen96/dsh-browser-use
 */

import { Config, resolveConfig } from './config.js'
import { ensureEngine, forgetEngine, reportText } from './engine.js'
import { registerInspector } from './inspector.js'
import { Sessions, labelFor } from './sessions.js'
import { ChildStatus } from './status.js'
import { browserGuidance, mountBrowserTools, mountDelegateTool, mountDoctor } from './tools.js'

/** Cordis identity for this provider. */
export const name = 'dsh-browser-use'

/** Services that must exist before the browser tools can be registered. */
export const inject = ['tools', 'agents', 'systemPrompt']

/** The creation label of a browser subagent, which is how a restarted plugin finds it again. */
const CHILD_LABEL = 'browser-task'

/** The prompt one delegated task carries, for a new child or for the persistent one. */
function childPrompt({ instruction, url }, { persistent = false, canMessage = false, followUp = false } = {}) {
  const lines = [
    followUp ? `New browser task from your parent:\n\n${instruction}` : instruction,
    url === ''
      ? 'Start with browser_page to read the page this Session already has open, or browser_open when nothing is open yet.'
      : `Start with browser_open on ${url}.`,
    'You drive the browser this Session owns. It stays open between tasks, so leave it on the page that answers the task and close it only when asked.',
  ]
  if (persistent && !followUp) {
    lines.push('You are the persistent browser agent of this conversation: later tasks arrive as new messages from your parent, and you keep the browser, the page, and what you learned between them.')
  }
  lines.push(persistent && canMessage
    ? 'Your parent does not see your transcript. Use send_message to your parent for a question that blocks you or a finding that changes the plan, and send the result the same way before you finish: the outcome you verified, the evidence you read for it, and anything you could not do.'
    : 'Finish with a report: the outcome you verified, the evidence you read for it, and anything you could not do.')
  return lines.join('\n\n')
}

/**
 * Settle a delegated run on the request signal as well as on its own result.
 *
 * The signal is the cancellation channel before and after startup: a provider cancels the child's
 * remaining work when it fires, but this plugin still has to end the tool call even if that provider
 * keeps the child running. What was already delivered to the browser is not rolled back.
 */
function raceAbort(result, signal) {
  if (signal === undefined) return result
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error(
        'dsh-browser-use: the delegation was cancelled. The browser may still finish what it already '
        + 'started, so read the page again before acting on it.',
      )
      error.kind = 'cancelled'
      reject(error)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    result.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** The text one delegation returns to the conversation that asked for the work. */
function delegationReport(result) {
  const text = result.output
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
    .trim()
  const lines = []
  if (result.stopReason !== 'completed') {
    lines.push(`The browser subagent ended with status ${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}.`)
  }
  lines.push(text === '' ? '(the browser subagent produced no report)' : text)
  if (result.stopReason !== 'completed') lines.push('Its report may be partial.')
  return lines.join('\n\n')
}

/**
 * Mount the browser tools inside one delegated child.
 *
 * They are registered in the child's own scope, so no other agent can see or run them, and the
 * child's global allow-list leaves its prompt with the browser tools, its task, the delegation
 * statement, and — for a persistent child — `send_message` back to its parent.
 */
function mountChild(ctx, agent, { config, sessions, ownerOf, allow }) {
  agent.ctx.effect(function* () {
    yield agent.ctx.tools.restrict({ allow })
    yield agent.ctx.systemPrompt.section({
      name: 'dsh-browser-use:browser',
      text: browserGuidance(config),
      order: agent.ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
    })
    for (const dispose of mountBrowserTools(agent.ctx, { ctx, config, sessions, ownerOf })) yield dispose
  }, 'dsh-browser-use.child')
}

/**
 * Register the provider: tools, usage rules, the browser-use slot, and the Session browsers.
 * @param ctx - context providing tools, the live Agent registry, and the prompt registry.
 * @param input - profile-owned browser, sidecar, and delegation configuration.
 */
export function apply(ctx, input) {
  const config = resolveConfig(input)
  /**
   * The configuration as it was handed to `apply`, still holding the Loader's live references.
   *
   * A field the Config marks `.volatile()` is edited in place by the Settings page: the Loader
   * commits the new value into the reference this object holds and emits `loader/volatile-update`,
   * without recomposing the plugin. Re-resolving the object and copying the answer over `config`
   * keeps the promise the schema makes — every reader below sees the new value at its next use, and
   * none of them has to know a reference exists.
   */
  const source = input ?? {}
  const refreshConfig = () => {
    const next = resolveConfig(source)
    for (const key of Object.keys(config)) if (!(key in next)) delete config[key]
    for (const [key, value] of Object.entries(next)) config[key] = value
    // The engine report is cached by interpreter, and a live edit may have changed which one is
    // asked for; the next reader probes again rather than repeating an answer for another config.
    forgetEngine()
  }

  /**
   * Browser child session id -> the session id of the conversation whose browser it drives.
   *
   * The owner is resolved by id when the child calls a tool, not held as an object: a persistent
   * child outlives any one Agent object of its parent, which is recomposed when it is resumed.
   */
  const childParents = new Map()
  /** Conversation session id -> its persistent browser child. */
  const persistentChild = new Map()
  /** Parent session id -> the delegation currently creating a child for it. */
  const creating = new Map()
  const ownerOf = agent => {
    if (agent === undefined) return undefined
    const parentId = childParents.get(agent.id)
    return parentId === undefined ? agent : ctx.get('agents')?.get(parentId)
  }
  const sessions = new Sessions(ctx, config)
  /** Whether each persistent browser child works or idles, for `browser_task_status` and the doctor. */
  const childStatus = new ChildStatus(ctx)

  /**
   * The provider that can compose an in-process child, resolved when it is asked for.
   *
   * `ctx.subagents` activates asynchronously, so it is regularly absent while this plugin applies
   * and present a moment later — a cached miss would silently disable delegation for the whole
   * session. The answer is therefore read at call time and whenever a provider is added or removed.
   */
  const usableProvider = () => {
    if (config.delegate !== true) return undefined
    const provider = ctx.get('subagents')?.getProvider(config.subagentProvider)
    return provider !== undefined && provider.capabilities?.toolFilter === true ? provider : undefined
  }
  const unavailableReason = () => {
    if (config.delegate !== true) return 'config.delegate is false'
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return 'this composition has no ctx.subagents service'
    if (subagents.getProvider(config.subagentProvider) === undefined) {
      return `no subagent provider is registered as "${config.subagentProvider}"`
    }
    return `provider "${config.subagentProvider}" does not compose an in-process child (no toolFilter capability)`
  }
  /** Whether this delegation keeps one child per conversation: the configuration and the host must both allow it. */
  const persistent = () => {
    if (config.delegateMode !== 'persistent') return false
    const subagents = ctx.get('subagents')
    const provider = usableProvider()
    return typeof subagents?.startContinuable === 'function'
      && typeof subagents?.sendMessage === 'function'
      && typeof provider?.prepareContinuable === 'function'
  }
  /** A persistent child may talk back to its parent when the composition offers `send_message`. */
  const childAllow = () => (persistent() && ctx.tools.get?.('send_message') !== undefined ? ['send_message'] : [])

  /** What the conversation holds right now: the browser tools, or the delegation tool. */
  let mounted = 'none'
  let conversationTools = []
  let delegationTools = []

  const unmount = () => {
    for (const dispose of delegationTools.splice(0).reverse()) dispose()
    for (const dispose of conversationTools.splice(0).reverse()) dispose()
  }
  const mountDirect = reason => {
    if (mounted === 'direct') return
    unmount()
    mounted = 'direct'
    conversationTools = mountBrowserTools(ctx, { ctx, config, sessions, ownerOf })
    if (config.delegate) {
      ctx.logger?.warn?.(
        `dsh-browser-use: browser work is not delegated (${reason}); the browser tools are mounted for this conversation instead`,
      )
    }
  }
  /** The browser children one conversation's durable catalog records, oldest first. */
  const catalogChildren = async (parentId, signal) => {
    try {
      const rows = await ctx.get('subagents')?.listChildren?.(parentId, signal) ?? []
      return rows.filter(row => row.mode === 'continuable' && row.label === CHILD_LABEL).map(row => row.id)
    } catch {
      return []
    }
  }
  /** The persistent browser child this conversation already has: remembered, or found in its catalog after a restart. */
  const findPersistent = async (owner, signal) => {
    const known = persistentChild.get(owner.id)
    if (known !== undefined) return known
    const found = (await catalogChildren(owner.id, signal)).at(-1)
    if (found === undefined) return undefined
    childParents.set(found, owner.id)
    persistentChild.set(owner.id, found)
    return found
  }
  const depthLimit = provider => (config.maxDepth > 0 && provider.capabilities?.depthLimit === true ? { maxDepth: config.maxDepth } : {})

  /** Start this conversation's persistent browser child with its first task. */
  const startPersistent = async ({ owner, signal, instruction, url, provider, subagents }) => {
    const allow = childAllow()
    creating.set(owner.id, { allow, persistent: true })
    let started
    try {
      started = await subagents.startContinuable({
        provider: config.subagentProvider,
        label: CHILD_LABEL,
        request: {
          prompt: [{ type: 'text', text: childPrompt({ instruction, url }, { persistent: true, canMessage: allow.length > 0 }) }],
          parent: owner,
          // The child sees what this plugin registers in its own scope, plus the way back to its parent.
          toolFilter: { allow },
          ...depthLimit(provider),
        },
        signal,
      })
    } finally {
      creating.delete(owner.id)
    }
    if (!childParents.has(started.childId)) {
      try { subagents.interrupt?.(started.childId, { kind: 'ancestor', agent: owner }) } catch {}
      throw new Error(
        'dsh-browser-use: the browser subagent was not composed in this process, so its browser tools could not be mounted',
      )
    }
    persistentChild.set(owner.id, started.childId)
    childStatus.handed(started.childId, { instruction, url }, 0)
    return started.childId
  }

  /** Hand one task to the conversation's persistent browser child, starting it when there is none. */
  const delegatePersistent = async ({ owner, signal, instruction, url, fresh, provider, subagents }) => {
    if (fresh) {
      const previous = persistentChild.get(owner.id) ?? (await catalogChildren(owner.id, signal)).at(-1)
      persistentChild.delete(owner.id)
      // Two children must not drive one browser at once: the one being replaced stops its turn.
      if (previous !== undefined) {
        try { subagents.interrupt?.(previous, { kind: 'ancestor', agent: owner }) } catch {}
      }
    }
    let childId = fresh ? undefined : await findPersistent(owner, signal)
    let continued = false
    if (childId !== undefined) {
      try {
        const text = childPrompt({ instruction, url }, { persistent: true, canMessage: childAllow().length > 0, followUp: true })
        const edges = childStatus.edges(childId)
        await subagents.sendMessage(owner, childId, [{ type: 'text', text }], { signal })
        childStatus.handed(childId, { instruction, url }, edges)
        continued = true
      } catch (error) {
        // A child whose state is gone cannot be continued; this conversation gets a new one.
        if (error?.code !== 'NOT_RESUMABLE') throw error
        persistentChild.delete(owner.id)
        childParents.delete(childId)
        childId = undefined
      }
    }
    if (childId === undefined) childId = await startPersistent({ owner, signal, instruction, url, provider, subagents })
    return persistentReceipt(owner, childId, continued)
  }
  /**
   * What `browser_task` answers once the task is handed over. It says in so many words how the
   * result arrives and what to do meanwhile: a receipt that only said "do not wait" was read as
   * "wait", and the conversation slept in a shell and polled agent-team tools that never saw the child.
   */
  const persistentReceipt = (owner, childId, continued) => {
    const id = JSON.stringify(childId)
    // Scoped tools — the agent-team tools among them — exist for one Agent, not in the global view.
    const has = name => ctx.tools.get?.(name, owner) !== undefined
    const teamTools = ['wait_agent', 'list_agents'].filter(has)
    const lines = [
      continued
        ? `Handed the task to this conversation's browser subagent ${id}. It keeps the page, the logins, and what it learned from earlier tasks.`
        : `Started this conversation's browser subagent ${id} and gave it the task.`,
      'It works in the background. You are notified when it finishes: its report arrives as a message in this conversation, and a conversation that has ended its turn is woken for it.',
      'Until then, continue with steps that do not need the result, or end your turn. Do not sleep, poll, or send the same task again.'
        + ` To see what it is doing, call browser_task_status; if you cannot go on without the result, call it with wait: true, which returns when the subagent finishes or messages you, or the user writes.`
        + (teamTools.length > 0 ? ` Agent-team tools (${teamTools.join(', ')}) do not see this subagent.` : ''),
      `Call browser_task again for the next task; it goes to the same subagent${has('send_message') ? `. Use send_message to ${id} to add to or correct the task it is working on` : ''}${has('interrupt_agent') ? `, and interrupt_agent on ${id} to stop it` : ''}.`,
    ]
    return lines.join('\n')
  }

  /** Run one task in a child that exists only for it, and return that child's report. */
  const delegateOnce = async ({ owner, signal, instruction, url, provider, subagents }) => {
    creating.set(owner.id, { allow: [] })
    let run
    try {
      run = await subagents.start(config.subagentProvider, {
        label: CHILD_LABEL,
        prompt: [{ type: 'text', text: childPrompt({ instruction, url }) }],
        parent: owner,
        signal,
        // The child sees only what this plugin registers in its own scope.
        toolFilter: { allow: [] },
        ...depthLimit(provider),
      })
    } finally {
      creating.delete(owner.id)
    }
    try {
      if (run.localAgent === undefined || !childParents.has(run.localAgent.id)) {
        throw new Error(
          'dsh-browser-use: the delegated child was not composed in this process, so its browser tools could not be mounted',
        )
      }
      signal.throwIfAborted()
      return delegationReport(await raceAbort(run.result, signal))
    } finally {
      // A one-shot delegation always gives the child back. The browser it drove stays with the
      // conversation that asked for the work, because that is what keeps its logins and tabs.
      await run.dispose().catch(() => {})
      if (run.localAgent !== undefined) childParents.delete(run.localAgent.id)
    }
  }

  const mountDelegated = () => {
    if (mounted === 'delegated') return
    unmount()
    mounted = 'delegated'
    // A delegated child is the only agent that ever sees a browser tool: nothing here can run
    // before a child was composed for this conversation.
    delegationTools = [
      ctx.on('agent/created', async ({ agent, source }) => {
        const header = agent.session?.header
        const parentId = header?.parentSession
        if (parentId === undefined || header?.origin !== 'subagent') return
        const record = creating.get(parentId)
        let allow
        if (record !== undefined) {
          allow = record.allow
        } else if (childParents.get(agent.id) === parentId) {
          // A persistent child cold-resumed for its next message: its browser tools come back with it.
          allow = childAllow()
        } else if (source !== 'startup' && persistent() && (await catalogChildren(parentId)).includes(agent.id)) {
          // A browser child this process has not met yet, resumed by a message after a restart.
          allow = childAllow()
          if (!persistentChild.has(parentId)) persistentChild.set(parentId, agent.id)
        } else {
          return
        }
        childParents.set(agent.id, parentId)
        // Only a persistent child reports its state: a one-shot child answers inside its browser_task call.
        if (record === undefined || record.persistent === true) childStatus.track(agent.id)
        mountChild(ctx, agent, { config, sessions, ownerOf, allow })
      }),
      ...mountDelegateTool(ctx, {
        config,
        sessions,
        persistent,
        status: async ({ owner, signal, wait, timeoutMs }) => {
          const childId = await findPersistent(owner, signal)
          if (childId === undefined) return 'No browser subagent works for this conversation yet: the first browser_task starts one.'
          childStatus.track(childId)
          const outcome = wait && childStatus.running(childId)
            ? await childStatus.wait({ ownerId: owner.id, childId, timeoutMs, signal })
            : undefined
          return childStatus.describe(childId, { view: sessions.viewOf(owner), wait, outcome })
        },
        delegate: async ({ owner, signal, instruction, url, fresh }) => {
          const provider = usableProvider()
          const subagents = ctx.get('subagents')
          if (provider === undefined || subagents === undefined) {
            throw new Error(`dsh-browser-use: browser delegation is unavailable (${unavailableReason()})`)
          }
          const task = { owner, signal, instruction, url, fresh, provider, subagents }
          if (!persistent()) return delegateOnce(task)
          try {
            return await delegatePersistent(task)
          } catch (error) {
            // A host that cannot keep a child still gets its browser work done, one task at a time.
            if (error?.code !== 'CONTINUATION_UNAVAILABLE' && error?.code !== 'PERSISTENCE_UNAVAILABLE') throw error
            ctx.logger?.warn?.(`dsh-browser-use: a persistent browser subagent is unavailable (${error.message}); this task runs in a one-shot child`)
            return delegateOnce(task)
          }
        },
      }),
    ]
  }
  const delegationStatus = owner => {
    if (mounted !== 'delegated') {
      return config.delegate
        ? `unavailable: ${unavailableReason()}; the browser tools run in this conversation`
        : 'off: config.delegate is false, so the browser tools run in this conversation'
    }
    if (!persistent()) {
      const why = config.delegateMode === 'one-shot' ? '' : ` (provider "${config.subagentProvider}" cannot continue a child)`
      return `on: one-shot${why}; provider "${config.subagentProvider}" runs each browser task in a new child`
    }
    const child = owner === undefined ? undefined : persistentChild.get(owner.id)
    return `on: persistent; provider "${config.subagentProvider}" keeps one browser subagent per conversation`
      + (child === undefined ? '' : ` (this conversation's: ${child}, ${childStatus.summary(child)})`)
  }

  /**
   * What the conversation's surface is built from: the switches that decide *which* tools exist, as
   * opposed to what those tools do. A live edit that changes this list rebuilds the surface; an edit
   * that does not (a model name, a key) leaves it alone.
   */
  const surfaceKey = () => JSON.stringify([
    config.delegate,
    config.delegateMode,
    config.subagentProvider,
    config.allowScreenshots,
    config.jev.enabled,
    usableProvider() !== undefined,
  ])
  /** The surface this session mounted, so the same answer is not rebuilt on every live edit. */
  let surface = ''
  /** Mount what the configuration asks for now, disposing and rebuilding when it changed underneath. */
  const mountSurface = () => {
    const next = surfaceKey()
    if (mounted !== 'none' && next === surface) return
    surface = next
    // Both mount functions treat their own state as "already mounted"; clearing it makes them
    // dispose what is there and compose the answer the new configuration asks for.
    mounted = 'none'
    if (config.delegate === true && usableProvider() !== undefined) mountDelegated()
    else mountDirect(unavailableReason())
  }

  ctx.effect(function* () {
    const registry = ctx.get('browserUse')
    if (registry && config.reserveBrowserUseSlot) {
      yield registry.register('browser-use')
    } else if (config.reserveBrowserUseSlot) {
      ctx.logger?.info?.('dsh-browser-use: no browser-use service in this composition; the tools load without reserving the slot')
    }
    yield () => sessions.dispose()
    yield () => unmount()
    // A browser child outlives the surface that started it, so its lifecycle is followed for as
    // long as the plugin runs; a `browser_task_status` wait still pending when it stops is let go.
    yield () => childStatus.release()
    yield ctx.on('subagent/start', info => childStatus.started(info?.id))
    yield ctx.on('subagent/end', info => childStatus.ended(info))
    yield ctx.on('agent/inbox/inserted', event => childStatus.inserted(event?.agent, event?.message))
    yield mountDoctor(ctx, { config, sessions, ownerOf, delegation: delegationStatus })
    // A provider can arrive after this plugin does, and it can leave again: both change what the
    // conversation holds, so neither answer is cached.
    yield ctx.on('subagent/provider-added', added => {
      if (config.delegate === true && added.name === config.subagentProvider && usableProvider() !== undefined) mountSurface()
    })
    yield ctx.on('subagent/provider-removed', removed => {
      if (removed === config.subagentProvider && mounted === 'delegated') mountSurface()
    })
    // The Settings page writes a live field through this event and never recomposes the plugin, so
    // the configuration is re-read here and the surface rebuilt if the switch that decides it moved.
    yield ctx.on('loader/volatile-update', () => {
      try {
        refreshConfig()
      } catch (error) {
        // A refused value keeps the configuration that was running: the Settings page validates
        // before it writes, and this only guards a hand-edited patch arriving the same way.
        ctx.logger?.warn?.(`dsh-browser-use: a live configuration edit was refused (${String(error)})`)
        return
      }
      mountSurface()
    })
    mountSurface()
    const inspector = registerInspector(ctx, sessions)
    if (inspector) yield inspector
  }, 'dsh-browser-use.runtime')

  // An installation that cannot drive a browser says so at load, and names the command that fixes
  // it: a plugin should not wait for the first tool call to reveal a missing prerequisite. A missing
  // engine this plugin can install is installed now, so the first browser call does not wait for it.
  ensureEngine(config, {
    onInstall: status => {
      ctx.logger?.info?.(
        `dsh-browser-use: installing the browser engine into ${status.environment} with uv; `
        + 'browser tools wait for it, and browser_doctor shows how far it got',
      )
    },
  }).then(report => {
    if (report.ok) {
      const engine = report.engine === undefined ? '' : ` (jev_ultrafast ${report.engine.engine}, browser-harness ${report.engine.browserHarness})`
      ctx.logger?.info?.(`dsh-browser-use: the browser engine is ready${engine}`)
      return
    }
    ctx.logger?.warn?.(`dsh-browser-use: the browser engine is not ready yet\n${reportText(report)}`)
  }).catch(error => {
    ctx.logger?.warn?.(`dsh-browser-use: the engine check itself failed: ${String(error)}`)
  })
}

export { Config, labelFor }

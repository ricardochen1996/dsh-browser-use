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
 *   conversation asks for an outcome instead of reading page tables it will never act on.
 * - **Direct**: without a usable subagent provider, or with `delegate: false`, the browser tools
 *   are mounted in the composition and the conversation calls them itself.
 *
 * Either way the browser belongs to the *conversation*: a delegated child drives the browser its
 * Session already owns, and the browser outlives the delegation that used it.
 *
 * @module @rc/dsh-browser-use
 */

import { inspectEngine, reportText } from './engine.js'
import { registerInspector } from './inspector.js'
import { Sessions, labelFor } from './sessions.js'
import { browserGuidance, mountBrowserTools, mountDelegateTool, mountDoctor } from './tools.js'

/** Cordis identity for this provider. */
export const name = 'dsh-browser-use'

/** Services that must exist before the browser tools can be registered. */
export const inject = ['tools', 'agents', 'systemPrompt']

const DEFAULTS = {
  /** The engine checkout to use. Empty means this package's own environment, then the checkout. */
  projectPath: '',
  /** Interpreter for the sidecar. Empty means this package's virtualenv, then the checkout's. */
  pythonPath: '',
  /** `launch` starts a browser this Session owns; `attach` uses `cdpEndpoint`. */
  mode: 'launch',
  /** WebSocket DevTools endpoint for `attach` mode (`ws://127.0.0.1:9222/devtools/browser/...`). */
  cdpEndpoint: '',
  /** Browser to launch. Empty means the usual Google Chrome or Chromium. */
  executablePath: '',
  /** Profile directory for a launched browser. Empty means one profile per Session. */
  userDataDir: '',
  /** Launch without a visible window. */
  headless: false,
  /** Register with `ctx.browserUse`, which admits one browser provider at a time. */
  reserveBrowserUseSlot: true,
  /** Offer `browser_goal`, which spends TypeSafe and text-helper quota. */
  allowGoalMode: false,
  /** Offer `browser_screenshot`. */
  allowScreenshots: true,
  /** Longest single sidecar request, in milliseconds. */
  requestTimeoutMs: 180000,
  /** Run browser work in a subagent; `false` mounts the browser tools for this conversation. */
  delegate: true,
  /** The `ctx.subagents` provider that starts the browser subagent, by registered name. */
  subagentProvider: 'spawn',
  /** Delegation-depth cap for the browser subagent; 0 leaves the provider's own budget in place. */
  maxDepth: 0,
}

/** Resolve caller configuration against the documented defaults. */
function resolveConfig(input) {
  const config = { ...DEFAULTS, ...(input ?? {}) }
  if (config.mode === 'attach' && !String(config.cdpEndpoint ?? '').trim()) {
    throw new Error('dsh-browser-use: attach mode requires cdpEndpoint')
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
    throw new Error('dsh-browser-use: requestTimeoutMs must be a positive number')
  }
  if (!Number.isFinite(config.maxDepth) || config.maxDepth < 0) {
    throw new Error('dsh-browser-use: maxDepth must be zero or a positive number')
  }
  if (config.delegate !== true && config.delegate !== false) {
    throw new Error('dsh-browser-use: delegate must be true or false')
  }
  return config
}

/** The prompt one delegated child receives. */
function childPrompt({ instruction, url }) {
  return [
    instruction,
    url === ''
      ? 'Start with browser_page to read the page this Session already has open, or browser_open when nothing is open yet.'
      : `Start with browser_open on ${url}.`,
    'You drive the browser this Session owns. It stays open between tasks, so leave it on the page that answers the task and close it only when asked.',
    'Finish with a report: the outcome you verified, the evidence you read for it, and anything you could not do.',
  ].join('\n\n')
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
 * child's empty global allow-list leaves its prompt with the browser tools, its task, and the
 * delegation statement — nothing else.
 */
function mountChild(ctx, agent, { config, sessions, ownerOf }) {
  agent.ctx.effect(function* () {
    yield agent.ctx.tools.restrict({ allow: [] })
    yield agent.ctx.systemPrompt.section({
      name: 'dsh-browser-use:browser',
      text: browserGuidance(),
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

  /** Child session id -> the conversation whose browser it drives. */
  const childOwners = new Map()
  /** Parent session id -> the delegation currently creating a child for it. */
  const creating = new Map()
  const ownerOf = agent => (agent === undefined ? undefined : childOwners.get(agent.id) ?? agent)
  const sessions = new Sessions(ctx, config)

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
  const mountDelegated = () => {
    if (mounted === 'delegated') return
    unmount()
    mounted = 'delegated'
    // A delegated child is the only agent that ever sees a browser tool, and it exists only while
    // its delegation does: nothing here can run before a child was composed for this conversation.
    delegationTools = [
      ctx.on('agent/created', ({ agent }) => {
        const parentId = agent.session?.header?.parentSession
        const record = parentId === undefined ? undefined : creating.get(parentId)
        if (record === undefined || agent.session?.header?.origin !== 'subagent') return
        childOwners.set(agent.id, record.owner)
        mountChild(ctx, agent, { config, sessions, ownerOf })
      }),
      ...mountDelegateTool(ctx, {
        config,
        sessions,
        delegate: async ({ owner, signal, instruction, url }) => {
          const provider = usableProvider()
          const subagents = ctx.get('subagents')
          if (provider === undefined || subagents === undefined) {
            throw new Error(`dsh-browser-use: browser delegation is unavailable (${unavailableReason()})`)
          }
          creating.set(owner.id, { owner })
          let run
          try {
            run = await subagents.start(config.subagentProvider, {
              label: 'browser-task',
              prompt: [{ type: 'text', text: childPrompt({ instruction, url }) }],
              parent: owner,
              signal,
              // The child sees only what this plugin registers in its own scope.
              toolFilter: { allow: [] },
              ...config.maxDepth > 0 && provider.capabilities?.depthLimit === true ? { maxDepth: config.maxDepth } : {},
            })
          } finally {
            creating.delete(owner.id)
          }
          try {
            if (run.localAgent === undefined || !childOwners.has(run.localAgent.id)) {
              throw new Error(
                'dsh-browser-use: the delegated child was not composed in this process, so its browser tools could not be mounted',
              )
            }
            signal.throwIfAborted()
            return delegationReport(await raceAbort(run.result, signal))
          } finally {
            // A delegation always gives the child back. The browser it drove stays with the
            // conversation that asked for the work, because that is what keeps its logins and tabs.
            await run.dispose().catch(() => {})
            if (run.localAgent !== undefined) childOwners.delete(run.localAgent.id)
          }
        },
      }),
    ]
  }
  const delegationStatus = () => mounted === 'delegated'
    ? `on: subagent provider "${config.subagentProvider}" runs the browser tools in a child`
    : config.delegate
      ? `unavailable: ${unavailableReason()}; the browser tools run in this conversation`
      : 'off: config.delegate is false, so the browser tools run in this conversation'

  ctx.effect(function* () {
    const registry = ctx.get('browserUse')
    if (registry && config.reserveBrowserUseSlot) {
      yield registry.register('browser-use')
    } else if (config.reserveBrowserUseSlot) {
      ctx.logger?.info?.('dsh-browser-use: no browser-use service in this composition; the tools load without reserving the slot')
    }
    yield () => sessions.dispose()
    yield () => unmount()
    yield mountDoctor(ctx, { config, sessions, ownerOf, delegation: delegationStatus })
    // A provider can arrive after this plugin does, and it can leave again: both change what the
    // conversation holds, so neither answer is cached.
    yield ctx.on('subagent/provider-added', added => {
      if (config.delegate === true && added.name === config.subagentProvider && usableProvider() !== undefined) mountDelegated()
    })
    yield ctx.on('subagent/provider-removed', removed => {
      if (removed === config.subagentProvider && mounted === 'delegated') {
        mountDirect(`provider "${config.subagentProvider}" was removed`)
      }
    })
    if (usableProvider() !== undefined) mountDelegated()
    else mountDirect(unavailableReason())
    const inspector = registerInspector(ctx, sessions)
    if (inspector) yield inspector
  }, 'dsh-browser-use.runtime')

  // An installation that cannot drive a browser says so at load, and names the command that fixes
  // it: a plugin should not wait for the first tool call to reveal a missing prerequisite.
  inspectEngine(config).then(report => {
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

export { labelFor }

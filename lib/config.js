/**
 * The plugin's Config: what the profile may set, what the Settings page may edit live, and how one
 * configuration object is resolved against the documented defaults.
 *
 * Two kinds of field, and the difference is visible to the person using the Plugins page:
 *
 * - **Live** fields (`.volatile()`) are read at the moment they are used — the next Jev call,
 *   the next tool mount — so the Plugins page can edit them and the change takes effect without a
 *   remount. The Loader hands those fields over as `Volatile` references and commits a new value
 *   into the very reference the plugin holds. Only jev's own switches are live: they are the ones a
 *   person tunes while working, and the ones whose readers re-read them every time.
 * - **Ordinary** fields are read once, when the plugin applies. Changing one in the profile patch
 *   recomposes the plugin, and the form does not offer it at all — `projectPath`, `pythonPath` and
 *   `reserveBrowserUseSlot` choose which process or composition runs, and `mode`, `delegate`,
 *   `allowScreenshots` and the rest decide *which tools exist*, so a form field for them would
 *   promise an immediacy the plugin cannot keep. They stay profile-patch settings.
 *
 * `resolveConfig` therefore unwraps references for validation and for the values the rest of the
 * plugin reads, while `apply` keeps the unresolved object: after a live edit it re-resolves that
 * object and copies the result into the configuration everyone already holds, so no reader has to
 * know a reference exists. See `lib/index.js`.
 *
 * @module dsh-browser-use/config
 */

import z from '@deepseek-ai/schemastery'

import { JEV_DEFAULTS, resolveJevConfig } from './jev.js'

/**
 * The mark a `Volatile` reference carries, and the only thing about it this plugin needs: the
 * protocol is shared across ESM/CJS copies of cosmokit, so it is looked up globally rather than
 * imported. The plugin deliberately does not depend on the loader's own packages.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a Config value is a live reference the Loader keeps up to date. */
export function isVolatile(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** One Config subtree as plain data: every live reference replaced by the value it holds now. */
export function plain(value) {
  if (isVolatile(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  }
  return value
}

/**
 * The plugin's Config as the Loader, the Settings page, and `dsh doctor` read it.
 *
 * Every field states its default here as well as in {@link DEFAULTS}: the profile patch is validated
 * against this schema before the plugin is composed, and the Settings page renders its form from the
 * live fields below. A default here is what the form shows for a field nobody has set.
 */
export const Config = z.object({
  /**
   * The engine checkout to use. Ordinary: it decides which interpreter runs the sidecar, so the
   * plugin re-resolves it only when the profile patch recomposes it.
   */
  projectPath: z.string().default(''),
  /** Interpreter for the sidecar. Ordinary, like `projectPath`. */
  pythonPath: z.string().default(''),
  /** `launch` starts a browser this Session owns; `attach` drives one that is already running. */
  mode: z.union(['launch', 'attach']).default('launch'),
  /** DevTools endpoint for `attach` mode; empty attaches to the Chrome you browse with. */
  cdpEndpoint: z.string().default(''),
  /** Browser to launch. Empty means the usual Google Chrome or Chromium. */
  executablePath: z.string().default(''),
  /** Profile directory for a launched browser. Empty means one profile per Session. */
  userDataDir: z.string().default(''),
  /** Launch without a visible window. */
  headless: z.boolean().default(false),
  /**
   * Register with `ctx.browserUse`, which admits one browser provider at a time. Ordinary: taking
   * the slot is a claim on the composition, not a preference to flip under a running Session.
   */
  reserveBrowserUseSlot: z.boolean().default(true),
  /**
   * Jev, the TypeSafe policy behind `browser_goal` and `browser_act`'s intent: off by default, since
   * it spends model quota. Read per call, so every field below is editable while the plugin runs.
   */
  jev: z.object({
    /** Offer `browser_goal` and `browser_act`'s intent, which spend TypeSafe and text-model quota. */
    enabled: z.boolean().default(false).volatile(),
    /** `session` inherits the main conversation's route and key; `custom` uses the fields below. */
    source: z.union(['session', 'custom']).default('session').volatile(),
    /** The TypeSafe endpoint; `baseURL`, `model` and `fallbackURL` apply in both modes. */
    typesafe: z.object({
      baseURL: z.string().default('').volatile(),
      model: z.string().default('').volatile(),
      fallbackURL: z.string().default(''),
      /** The key itself, for `source: custom`. Kept out of every form response. */
      apiKey: z.string().role('secret').default('').volatile(),
      /** The name of a DSH credential holding that key, which is what a form should offer. */
      apiKeyEnv: z.string().role('credential-ref').default('').volatile(),
    }).default({}),
    /** The OpenAI-compatible text helper; `model`, `reasoning` and `headers` apply in both modes. */
    textModel: z.object({
      baseURL: z.string().default('').volatile(),
      model: z.string().default('').volatile(),
      reasoning: z.union(['', 'none', 'thinking-disabled']).default(''),
      headers: z.dict(z.string()).default({}),
      apiKey: z.string().role('secret').default('').volatile(),
      apiKeyEnv: z.string().role('credential-ref').default('').volatile(),
    }).default({}),
  }).default({}),
  /**
   * The older name for `jev.enabled`, still accepted. Ordinary and defaultless on purpose: the
   * resolver treats a present value as an override, so a default here would silently win over
   * `jev.enabled` for every profile that never wrote it.
   */
  allowGoalMode: z.boolean(),
  /** Offer `browser_screenshot`. */
  allowScreenshots: z.boolean().default(true),
  /** Longest single sidecar request, in milliseconds. */
  requestTimeoutMs: z.number().step(1).min(1).default(180000),
  /** Run browser work in a subagent; `false` mounts the browser tools for this conversation. */
  delegate: z.boolean().default(true),
  /** `persistent` keeps one browser subagent per conversation; `one-shot` starts a child per task. */
  delegateMode: z.union(['persistent', 'one-shot']).default('persistent'),
  /** The `ctx.subagents` provider that starts the browser subagent, by registered name. */
  subagentProvider: z.string().default('spawn'),
  /** Delegation-depth cap for the browser subagent; 0 leaves the provider's own budget in place. */
  maxDepth: z.number().step(1).min(0).default(0),
})

/** The documented defaults, in the shape `apply` resolves a configuration to. */
export const DEFAULTS = {
  projectPath: '',
  pythonPath: '',
  mode: 'launch',
  cdpEndpoint: '',
  executablePath: '',
  userDataDir: '',
  headless: false,
  reserveBrowserUseSlot: true,
  jev: JEV_DEFAULTS,
  allowScreenshots: true,
  requestTimeoutMs: 180000,
  delegate: true,
  delegateMode: 'persistent',
  subagentProvider: 'spawn',
  maxDepth: 0,
}

/** Resolve caller configuration against the documented defaults. */
export function resolveConfig(input) {
  // The Loader hands live fields over as references; validation and the resolved values both want
  // the data behind them, and never the reference itself.
  const config = { ...DEFAULTS, ...plain(input ?? {}) }
  config.jev = resolveJevConfig(plain(input ?? {}))
  delete config.allowGoalMode
  if (config.mode !== 'launch' && config.mode !== 'attach') {
    throw new Error('dsh-browser-use: mode must be "launch" or "attach"')
  }
  config.cdpEndpoint = String(config.cdpEndpoint ?? '').trim()
  if (config.mode === 'attach' && config.cdpEndpoint !== '') {
    const endpoint = config.cdpEndpoint
    // The rule the MCP providers apply too: an http(s) or ws(s) URL, no whitespace. An HTTP endpoint
    // is resolved through /json/version, so it keeps working after the browser restarts, while a ws
    // URL carries an id Chrome mints afresh on every start.
    if (!/^(?:https?|wss?):\/\/\S+$/u.test(endpoint)) {
      throw new Error('dsh-browser-use: attach mode cdpEndpoint must be an http(s) or ws(s) URL without whitespace')
    }
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
  if (config.delegateMode !== 'persistent' && config.delegateMode !== 'one-shot') {
    throw new Error('dsh-browser-use: delegateMode must be "persistent" or "one-shot"')
  }
  return config
}

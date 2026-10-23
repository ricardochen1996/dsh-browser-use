/**
 * The plugin's Config: what the profile may set, what the Settings page may edit live, and how one
 * configuration object is resolved against the documented defaults.
 *
 * Two kinds of field, and the difference is visible to the person using the Plugins page:
 *
 * - **Live** fields (`.volatile()`) are read at the moment they are used — the next Jev call,
 *   the next tool mount, the next `browser_open` — so the Plugins page can edit them and the change
 *   takes effect without a remount. The Loader hands those fields over as `Volatile` references and
 *   commits a new value into the very reference the plugin holds. jev's own switches are live, and so
 *   are the two connection switches (`mode`, `attachSharing`): they are the questions a person
 *   answers while working, and every reader of them reads the value again at its next use, which is
 *   what lets a form field keep the promise it makes.
 * - **Ordinary** fields are read once, when the plugin applies. Changing one in the profile patch
 *   recomposes the plugin, and the form does not offer it at all — `projectPath`, `pythonPath` and
 *   `reserveBrowserUseSlot` choose which process or composition runs, and `delegate`,
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
  /**
   * `launch` starts a browser this Session owns; `attach` drives one that is already running. Live,
   * because the next `browser_open` is what reads it: a switch in the settings form has to mean what
   * it says, and it costs nothing here — a browser a Session already opened keeps the mode it was
   * opened under, so flipping this never reaches back into a running browser.
   */
  mode: z.union(['launch', 'attach']).default('launch').volatile(),
  /**
   * Who may drive the attached browser: `exclusive` keeps it for the first live Session, `shared`
   * lets every live Session drive it at once, each in its own tab.
   *
   * Only `attach` mode has anything to share — a launched browser is already this Session's own —
   * and sharing changes nothing about how a Session lets go: closing one Session's browser closes
   * that Session's tab and stops its daemon, never the external browser it was attached to. Live for
   * the same reason as `mode`, and the form refuses it while `mode` is `launch`, which is the one
   * combination the schema rejects below.
   */
  attachSharing: z.union(['exclusive', 'shared']).default('exclusive').volatile(),
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
   * Jev, the policy behind `browser_goal` and `browser_act`'s intent. It is on whenever this plugin is:
   * the form's one switch says **who answers it**, not whether it runs. The ordinary fields here
   * (`enabled`, `source`, `textModel`) are for a profile patch that wants less than the whole thing.
   */
  jev: z.object({
    /**
     * Offer `browser_goal` and `browser_act`'s intent at all — true unless a profile patch withdraws
     * them. Not a form field: there is no switch to turn off, only a choice of who decides.
     */
    enabled: z.boolean().default(true),
    /** `session` inherits the main conversation's route and key; `custom` uses the fields below. */
    source: z.union(['session', 'custom']).default('session'),
    /**
     * Who answers the loop's questions, and the one thing the settings page asks: `typesafe` calls the
     * TypeSafe endpoint below; `chat` has the sidecar answer them from the text model, so the TypeSafe
     * section is not used and no TypeSafe key is resolved.
     */
    decider: z.union(['typesafe', 'chat']).default('typesafe').volatile(),
    /**
     * The TypeSafe endpoint and key. The key field is the Jev key itself — a live secret, written by
     * the form and never sent back — and an empty one spends the main conversation route's own key,
     * which is what the form leaves in place. `apiKeyEnv` (a DSH credential or environment variable
     * name) and `fallbackURL` are the YAML-only alternatives, so the form offers no credential to
     * name: the answer to "which key does Jev use" is the key.
     */
    typesafe: z.object({
      baseURL: z.string().default('').volatile(),
      model: z.string().default('').volatile(),
      fallbackURL: z.string().default(''),
      /** The Jev key itself; without one the main conversation's key is spent. The form's third row. */
      apiKey: z.string().role('secret').default('').volatile(),
      /** The name of a DSH credential holding that key, for a profile patch that would rather not store it. */
      apiKeyEnv: z.string().role('credential-ref').default(''),
    }).default({}),
    /**
     * The OpenAI-compatible text helper — not in the form: the main conversation's route supplies the
     * endpoint, model and key, and reasoning is off by default because a value to type never needs it.
     * A profile patch may still override the model, the reasoning switch and extra headers; with
     * `source: custom` it also needs `baseURL` and its own key.
     */
    textModel: z.object({
      baseURL: z.string().default(''),
      model: z.string().default(''),
      reasoning: z.union(['', 'none', 'thinking-disabled']).default('thinking-disabled'),
      headers: z.dict(z.string()).default({}),
      apiKey: z.string().role('secret').default(''),
      apiKeyEnv: z.string().role('credential-ref').default(''),
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
  /**
   * Offer `browser_eval`: one JavaScript expression evaluated through the Session's own CDP
   * connection. On by default because its absence is what pushes a model to start a second CDP
   * client, which Chrome 144+ answers with one "Allow remote debugging?" prompt per connection. A
   * profile patch that wants only the guarded action-space surface sets it to false.
   */
  allowEval: z.boolean().default(true),
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
  /**
   * Push a progress message into the owning conversation while the browser subagent works. Ordinary
   * like the rest of the delegation: it decides whether a whole class of messages exists, and the
   * feed reads it on every step.
   */
  progress: z.boolean().default(true),
  /** Shortest gap between two progress messages; each push may wake the conversation. */
  progressIntervalMs: z.number().step(1).min(0).default(30000),
})

/** The documented defaults, in the shape `apply` resolves a configuration to. */
export const DEFAULTS = {
  projectPath: '',
  pythonPath: '',
  mode: 'launch',
  attachSharing: 'exclusive',
  cdpEndpoint: '',
  executablePath: '',
  userDataDir: '',
  headless: false,
  reserveBrowserUseSlot: true,
  jev: JEV_DEFAULTS,
  allowScreenshots: true,
  allowEval: true,
  requestTimeoutMs: 180000,
  delegate: true,
  delegateMode: 'persistent',
  subagentProvider: 'spawn',
  maxDepth: 0,
  progress: true,
  progressIntervalMs: 30000,
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
  if (config.attachSharing !== 'exclusive' && config.attachSharing !== 'shared') {
    throw new Error('dsh-browser-use: attachSharing must be "exclusive" or "shared"')
  }
  // Sharing describes an external browser two Sessions could both reach. A launched browser is one
  // Session's own, so accepting the setting there would promise a sharing that never happens.
  if (config.attachSharing === 'shared' && config.mode !== 'attach') {
    throw new Error(
      'dsh-browser-use: attachSharing "shared" needs mode "attach"; '
      + 'a launched browser already belongs to one Session, and each Session launches its own',
    )
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
  if (!Number.isFinite(config.progressIntervalMs) || config.progressIntervalMs < 0) {
    throw new Error('dsh-browser-use: progressIntervalMs must be zero or a positive number')
  }
  if (config.delegate !== true && config.delegate !== false) {
    throw new Error('dsh-browser-use: delegate must be true or false')
  }
  // The tool surface decides whether the escape hatch exists at all, so a profile patch gets the
  // Loader's own answer rather than a truthy value that silently mounts nothing.
  if (config.allowEval !== true && config.allowEval !== false) {
    throw new Error('dsh-browser-use: allowEval must be true or false')
  }
  // The feed reads this switch strictly, so a truthy non-boolean would turn the stream off in
  // silence: the profile gets the same answer here that the Loader's Config schema gives it.
  if (config.progress !== true && config.progress !== false) {
    throw new Error('dsh-browser-use: progress must be true or false')
  }
  if (config.delegateMode !== 'persistent' && config.delegateMode !== 'one-shot') {
    throw new Error('dsh-browser-use: delegateMode must be "persistent" or "one-shot"')
  }
  return config
}

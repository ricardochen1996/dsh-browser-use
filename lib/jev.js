/**
 * Jev: the TypeSafe policy behind `browser_goal` and `browser_act`'s intent, and where its endpoints
 * and keys come from.
 *
 * Jev is on whenever the plugin is — `browser_goal` and `browser_act`'s intent are part of what this
 * plugin offers. What the configuration decides is **who answers the loop's questions**
 * (`jev.decider`), where the text model comes from (`jev.source`), and, for a patch that wants less
 * than the whole thing, whether the tools are offered at all (`jev.enabled`):
 *
 * - `typesafe` (the default) sends those questions to the TypeSafe endpoint. `chat` serves the engine's
 *   own chat-model endpoint on loopback instead and points the engine's TypeSafe variables at it: the
 *   text model decides the operation and the target, and no TypeSafe endpoint or key is resolved.
 * - `session` (the default) inherits the text model from the main conversation: its current provider
 *   route's endpoint, model, headers and key. TypeSafe is called with that same key unless
 *   `jev.typesafe.apiKey` — the Jev key the settings form asks for — names one of its own.
 * - `custom` takes the text model's endpoint and key from `jev.textModel`, which only a profile patch
 *   sets: the settings form deliberately offers no second text model to configure.
 *
 * Nothing is read from the engine checkout's `.env`, and DSH's own environment variables under the
 * engine's names are scrubbed before the sidecar starts. The variables are resolved per call that
 * spends model quota — a `browser_goal`, or a `browser_act` with an intent — since the main
 * conversation can switch models between two calls, and handed to the sidecar with that one request.
 *
 * @module dsh-browser-use/jev
 */

/** Variables the engine reads for a goal run, all set from the plugin configuration. */
export const ENGINE_VARIABLES = [
  'JEV_DECIDER',
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'TYPESAFE_FALLBACK_URL',
  'TEXT_MODEL_API_KEY', 'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING', 'TEXT_MODEL_HEADERS',
]

export const JEV_DEFAULTS = {
  /**
   * Whether the policy is offered at all. On whenever the plugin is: the form does not ask, because a
   * switch that turns the tools off is not a question a person has — who answers them is. A profile
   * patch may still withdraw them with `enabled: false`.
   */
  enabled: true,
  /** `session` inherits the main conversation's provider route and key; `custom` uses the fields below. */
  source: 'session',
  /**
   * Who answers the loop's questions. `typesafe` calls the TypeSafe endpoint; `chat` has the sidecar
   * serve the engine's chat-model endpoint on loopback, so the text model decides and no TypeSafe
   * endpoint or key is needed.
   */
  decider: 'typesafe',
  /**
   * The TypeSafe endpoint. `baseURL`, `model` and `fallbackURL` apply in either source, since the
   * main conversation has no TypeSafe endpoint to inherit; `apiKey` — the key itself, which is what
   * the settings form writes — and `apiKeyEnv` also apply in either source, spending one of Jev's own
   * keys instead of the inherited one.
   */
  typesafe: { baseURL: '', model: '', fallbackURL: '', apiKey: '', apiKeyEnv: '' },
  /**
   * The OpenAI-compatible text helper. The main conversation supplies the endpoint, model and key
   * (`source: session`); `model` (empty = the conversation's own), `reasoning` — off by default, since
   * a value to type never needs it — and `headers` are added on top, and `source: custom` uses this
   * section's `baseURL` and key instead.
   */
  textModel: { baseURL: '', model: '', reasoning: 'thinking-disabled', headers: {}, apiKey: '', apiKeyEnv: '' },
}

/**
 * Fields that name an endpoint or a key and belong to the main conversation. The TypeSafe key is not
 * one of them: an explicit key there overrides the inherited one instead of being refused.
 */
const CUSTOM_ONLY = {
  textModel: ['baseURL', 'apiKey', 'apiKeyEnv'],
}

const fail = message => { throw new Error(`dsh-browser-use: ${message}`) }

/** One endpoint section: defaults filled in, strings trimmed, URLs and the key name checked. */
function section(label, defaults, input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    fail(`${label} must be a mapping`)
  }
  for (const key of Object.keys(input ?? {})) {
    if (!(key in defaults)) fail(`${label}.${key} is not a setting (known: ${Object.keys(defaults).join(', ')})`)
  }
  const result = { ...defaults, ...(input ?? {}) }
  for (const [key, value] of Object.entries(result)) {
    if (key === 'headers') continue
    if (value === undefined || value === null) result[key] = ''
    else if (typeof value !== 'string') fail(`${label}.${key} must be a string`)
    else result[key] = value.trim()
  }
  for (const key of ['baseURL', 'fallbackURL']) {
    if (result[key] && !/^https?:\/\/\S+$/u.test(result[key])) fail(`${label}.${key} must be an http(s) URL`)
  }
  if (result.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(result.apiKeyEnv)) {
    fail(`${label}.apiKeyEnv must be a variable name, not the key itself; put the key in ${label}.apiKey`)
  }
  return result
}

/**
 * Resolve `jev` against its defaults, accepting the older top-level `allowGoalMode` as `enabled`.
 * @param input - the plugin configuration as written.
 */
export function resolveJevConfig(input) {
  const raw = input?.jev
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) fail('jev must be a mapping')
  const jev = { ...JEV_DEFAULTS, ...(raw ?? {}) }
  if (raw?.enabled === undefined && input?.allowGoalMode !== undefined) jev.enabled = input.allowGoalMode
  if (jev.enabled !== true && jev.enabled !== false) fail('jev.enabled must be true or false')
  if (jev.source !== 'session' && jev.source !== 'custom') fail('jev.source must be "session" or "custom"')
  if (jev.decider !== 'typesafe' && jev.decider !== 'chat') fail('jev.decider must be "typesafe" or "chat"')
  jev.typesafe = section('jev.typesafe', JEV_DEFAULTS.typesafe, raw?.typesafe)
  jev.textModel = section('jev.textModel', JEV_DEFAULTS.textModel, raw?.textModel)
  if (!['', 'none', 'thinking-disabled'].includes(jev.textModel.reasoning)) {
    fail('jev.textModel.reasoning must be "", "none" or "thinking-disabled"')
  }
  const headers = jev.textModel.headers ?? {}
  if (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string')) {
    fail('jev.textModel.headers must map header names to strings')
  }
  jev.textModel.headers = { ...headers }
  // The TypeSafe section is simply not read when the text model decides. That is left standing rather
  // than refused: switching the one form switch between the two ways of deciding would otherwise be a
  // way to make a configured endpoint refuse to load, and the doctor names it instead (see `describe`).
  if (jev.source === 'session') {
    for (const [name, keys] of Object.entries(CUSTOM_ONLY)) {
      for (const key of keys) {
        if (jev[name][key] !== '') {
          fail(`jev.${name}.${key} only applies to jev.source: custom; with source: session the main conversation's provider supplies it`)
        }
      }
    }
  }
  for (const key of Object.keys(raw ?? {})) {
    if (!(key in JEV_DEFAULTS)) fail(`jev.${key} is not a setting (known: ${Object.keys(JEV_DEFAULTS).join(', ')})`)
  }
  return jev
}

/** Why jev cannot run with the current configuration or conversation; carries the fix in its text. */
export class JevUnavailable extends Error {}

/** Resolve one credential name through DSH's credentials service, then DSH's environment. */
async function credential(ctx, name) {
  const credentials = ctx?.get?.('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(name)
      if (hit?.value) return { value: hit.value, source: `DSH credential ${name}` }
    } catch {}
  }
  const ambient = process.env[name]
  if (ambient) return { value: ambient, source: `environment variable ${name}` }
  return undefined
}

/** A key from one of jev's own sections: its literal `apiKey`, or the credential `apiKeyEnv` names. */
async function customKey(ctx, label, section) {
  if (section.apiKey) return { value: section.apiKey, source: `${label}.apiKey` }
  if (!section.apiKeyEnv) {
    throw new JevUnavailable(`no key for ${label}: set ${label}.apiKey to the key itself, `
      + `or name a stored one with ${label}.apiKeyEnv`)
  }
  const hit = await credential(ctx, section.apiKeyEnv)
  if (hit === undefined) {
    throw new JevUnavailable(`${label}.apiKeyEnv names ${section.apiKeyEnv}, which is not set: store it in DSH (Models page) or export it`)
  }
  return hit
}

/**
 * The main conversation's route: provider and model from its last request, endpoint and credential
 * name from that provider's profile in DSH's settings.
 * @param owner - the conversation's agent (the Session that owns the browser).
 */
export async function sessionRoute(ctx, owner) {
  const route = owner?.session?.requestHeader?.()?.config
  if (!route?.provider || !route?.model) {
    throw new JevUnavailable('the main conversation has not chosen a model yet, so there is nothing to inherit; use jev.source: custom')
  }
  const llm = ctx?.get?.('llm')
  const settings = ctx?.get?.('settings')
  const entry = llm?.listConfigurableProviders?.().find(item => item.provider === route.provider)
  if (entry === undefined || settings === undefined) {
    throw new JevUnavailable(`provider route "${route.provider}" does not expose an endpoint and key to inherit${settings === undefined ? ' (no settings service)' : ''}; use jev.source: custom`)
  }
  let profile = settings.describe().find(item => item.ns === entry.settingsNs)?.value
  for (const key of entry.settingsPath) profile = profile?.[key]
  if (profile === undefined || profile === null || typeof profile !== 'object') {
    throw new JevUnavailable(`provider route "${route.provider}" has no stored profile to inherit; use jev.source: custom`)
  }
  if (profile.api === 'anthropic-messages') {
    throw new JevUnavailable(`provider route "${route.provider}" speaks Anthropic Messages, and the Jev text helper needs an OpenAI-compatible /chat/completions endpoint; switch the conversation to another route or use jev.source: custom`)
  }
  const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
  if (baseURL === '' && !/deepseek/iu.test(route.provider)) {
    throw new JevUnavailable(`provider route "${route.provider}" names no baseURL to inherit; use jev.source: custom`)
  }
  const keyName = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined
  if (keyName === undefined) {
    throw new JevUnavailable(`provider route "${route.provider}" authenticates without a named API key (a sign-in, for instance), which the engine cannot reuse; use jev.source: custom`)
  }
  const key = await credential(ctx, keyName)
  if (key === undefined) {
    throw new JevUnavailable(`provider route "${route.provider}" names ${keyName}, which is not set in DSH`)
  }
  const headers = profile.headers && typeof profile.headers === 'object' ? { ...profile.headers } : {}
  return { provider: route.provider, model: route.model, baseURL, headers, key }
}

/**
 * The engine variables one model-spending call runs with, and a description of where they came from.
 * With `jev.decider: chat` the TypeSafe variables are deliberately left out: the sidecar fills
 * `TYPESAFE_BASE_URL` / `TYPESAFE_MODEL` itself, pointing them at the endpoint it serves for that one
 * call, and the text model is the only model this resolves.
 * @param config - resolved plugin configuration.
 * @param ctx - the composition context (credentials, llm, settings services).
 * @param owner - the conversation whose browser, and whose model in `session` mode, the call uses.
 * @throws JevUnavailable - with the setting that fixes it.
 */
export async function jevEnvironment(config, ctx, owner) {
  const { jev } = config
  if (!jev.enabled) throw new JevUnavailable('jev is off: set jev.enabled: true in the plugin config')
  const env = {}
  const set = (name, value) => { if (value !== undefined && value !== '') env[name] = String(value) }
  // With `chat`, the sidecar serves the engine's chat-model endpoint on loopback and points the
  // engine's own TypeSafe variables at it, so this resolves no TypeSafe endpoint and no TypeSafe key:
  // the text model below is the one that decides.
  const chat = jev.decider === 'chat'
  if (chat) {
    env.JEV_DECIDER = 'chat'
  } else {
    set('TYPESAFE_BASE_URL', jev.typesafe.baseURL)
    set('TYPESAFE_MODEL', jev.typesafe.model)
    set('TYPESAFE_FALLBACK_URL', jev.typesafe.fallbackURL)
  }
  set('TEXT_MODEL_REASONING', jev.textModel.reasoning)
  let typesafeKey
  let textKey
  let text
  if (jev.source === 'session') {
    const route = await sessionRoute(ctx, owner)
    // A key written for TypeSafe is spent on TypeSafe; without one the conversation's own is, which is
    // what the form's empty Jev key field leaves in place.
    if (!chat) {
      typesafeKey = jev.typesafe.apiKey !== '' || jev.typesafe.apiKeyEnv !== ''
        ? await customKey(ctx, 'jev.typesafe', jev.typesafe)
        : route.key
    }
    textKey = route.key
    text = { baseURL: route.baseURL, model: jev.textModel.model || route.model, headers: { ...route.headers, ...jev.textModel.headers } }
    text.from = `the main conversation's route ${route.provider}`
  } else {
    if (!chat) typesafeKey = await customKey(ctx, 'jev.typesafe', jev.typesafe)
    textKey = await customKey(ctx, 'jev.textModel', jev.textModel)
    text = { baseURL: jev.textModel.baseURL, model: jev.textModel.model, headers: jev.textModel.headers, from: 'jev.textModel' }
  }
  if (typesafeKey !== undefined) set('TYPESAFE_API_KEY', typesafeKey.value)
  set('TEXT_MODEL_API_KEY', textKey.value)
  set('TEXT_MODEL_BASE_URL', text.baseURL)
  set('TEXT_MODEL', text.model)
  if (Object.keys(text.headers).length > 0) set('TEXT_MODEL_HEADERS', JSON.stringify(text.headers))
  const textLine = `text model ${text.model || '(engine default model)'} at ${text.baseURL || '(engine default endpoint)'} (from ${text.from}), key from ${textKey.source}`
  // The text model decides, so nothing here reads the Jev endpoint — but a value left in it is said
  // out loud, because a person who filled that form should not wonder which endpoint is in use.
  const unused = Object.keys(JEV_DEFAULTS.typesafe).filter(key => jev.typesafe[key] !== '')
  const describe = chat
    ? [`decisions from ${textLine}${unused.length === 0 ? '' : `; a Jev endpoint is configured but unused with jev.decider: chat (jev.typesafe.${unused.join('/')})`}`]
    : [
        `Jev endpoint ${jev.typesafe.model || '(engine default model)'} at ${jev.typesafe.baseURL || '(engine default endpoint)'}, key from ${typesafeKey.source}`,
        textLine,
      ]
  return { env, describe }
}

/** The doctor's view of jev: whether it is on, whose credentials it spends, and what is missing. Never a key. */
export async function jevStatus(config, ctx, owner) {
  if (!config.jev.enabled) return 'off (jev.enabled is false; browser_goal and browser_act intents are not offered and no key is resolved)'
  try {
    const { describe } = await jevEnvironment(config, ctx, owner)
    return [`on, source ${config.jev.source}`, ...describe].join('; ')
  } catch (error) {
    if (!(error instanceof JevUnavailable)) throw error
    return `on, source ${config.jev.source}, NOT USABLE: ${error.message}`
  }
}

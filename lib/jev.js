/**
 * Jev: the TypeSafe policy behind `browser_goal` and `browser_act`'s intent, and where its endpoints
 * and keys come from.
 *
 * Only the plugin configuration decides. `jev.enabled` turns the policy on; `jev.source` says whose
 * credentials it spends:
 *
 * - `session` inherits them from the main conversation: its current provider route (endpoint, key,
 *   headers) and model drive the text helper, and TypeSafe is called with that route's key.
 * - `custom` takes `baseURL` / `apiKey` / `apiKeyEnv` from `jev.typesafe` and `jev.textModel`.
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
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'TYPESAFE_FALLBACK_URL',
  'TEXT_MODEL_API_KEY', 'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING', 'TEXT_MODEL_HEADERS',
]

export const JEV_DEFAULTS = {
  /** Offer `browser_goal` and `browser_act`'s intent, which spend TypeSafe and text-model quota. */
  enabled: false,
  /** `session` inherits the main conversation's provider route and key; `custom` uses the fields below. */
  source: 'session',
  /**
   * The TypeSafe endpoint. `baseURL`, `model` and `fallbackURL` apply in both modes (the main
   * conversation has no TypeSafe endpoint to inherit); `apiKey` / `apiKeyEnv` only with `custom`.
   */
  typesafe: { baseURL: '', model: '', fallbackURL: '', apiKey: '', apiKeyEnv: '' },
  /**
   * The OpenAI-compatible text helper. `model`, `reasoning` and `headers` apply in both modes (with
   * `session`, an empty `model` means the main conversation's, and `headers` are added to the route's
   * own); `baseURL`, `apiKey` and `apiKeyEnv` only with `custom`.
   */
  textModel: { baseURL: '', model: '', reasoning: '', headers: {}, apiKey: '', apiKeyEnv: '' },
}

/** Fields that name an endpoint or a key: owned by the main conversation in `session` mode. */
const CUSTOM_ONLY = {
  typesafe: ['apiKey', 'apiKeyEnv'],
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
    fail(`${label}.apiKeyEnv must be a variable name, not the key itself`)
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

/** A key from a custom section: its literal `apiKey`, or the credential `apiKeyEnv` names. */
async function customKey(ctx, label, section) {
  if (section.apiKey) return { value: section.apiKey, source: `${label}.apiKey` }
  if (!section.apiKeyEnv) throw new JevUnavailable(`no key for ${label}: set ${label}.apiKeyEnv (or ${label}.apiKey)`)
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
  set('TYPESAFE_BASE_URL', jev.typesafe.baseURL)
  set('TYPESAFE_MODEL', jev.typesafe.model)
  set('TYPESAFE_FALLBACK_URL', jev.typesafe.fallbackURL)
  set('TEXT_MODEL_REASONING', jev.textModel.reasoning)
  let typesafeKey
  let textKey
  let text
  if (jev.source === 'session') {
    const route = await sessionRoute(ctx, owner)
    typesafeKey = route.key
    textKey = route.key
    text = { baseURL: route.baseURL, model: jev.textModel.model || route.model, headers: { ...route.headers, ...jev.textModel.headers } }
    text.from = `the main conversation's route ${route.provider}`
  } else {
    typesafeKey = await customKey(ctx, 'jev.typesafe', jev.typesafe)
    textKey = await customKey(ctx, 'jev.textModel', jev.textModel)
    text = { baseURL: jev.textModel.baseURL, model: jev.textModel.model, headers: jev.textModel.headers, from: 'jev.textModel' }
  }
  set('TYPESAFE_API_KEY', typesafeKey.value)
  set('TEXT_MODEL_API_KEY', textKey.value)
  set('TEXT_MODEL_BASE_URL', text.baseURL)
  set('TEXT_MODEL', text.model)
  if (Object.keys(text.headers).length > 0) set('TEXT_MODEL_HEADERS', JSON.stringify(text.headers))
  const describe = [
    `TypeSafe ${jev.typesafe.model || '(engine default model)'} at ${jev.typesafe.baseURL || '(engine default endpoint)'}, key from ${typesafeKey.source}`,
    `text model ${text.model || '(engine default model)'} at ${text.baseURL || '(engine default endpoint)'} (from ${text.from}), key from ${textKey.source}`,
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

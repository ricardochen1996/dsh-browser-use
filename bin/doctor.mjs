#!/usr/bin/env node
/**
 * Check what this plugin needs before DSH ever calls it: the interpreter, the engine, and the browser.
 *
 * Run it right after installing the plugin, or in CI:
 *   node bin/doctor.mjs [--install] [--mode launch|attach] [--cdp-endpoint URL] [/path/to/jev-ultrafast]
 * With --install, an engine this plugin installs itself is installed now (or the failed install
 * retried), with the installer's output on stderr. With --mode attach, the browser that mode drives
 * is checked too, so the same answer DSH logs at load can be had from a terminal. Exit status is 0
 * when the browser tools would work, 1 when something named below has to be fixed, and 2 when the
 * arguments are wrong.
 */

import { ensureEngine, inspectEngine, reportText } from '../lib/engine.js'

const USAGE = 'usage: node bin/doctor.mjs [--install] [--mode launch|attach] [--cdp-endpoint URL] [/path/to/jev-ultrafast]'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

const options = { install: false, mode: 'launch', cdpEndpoint: '' }
const rest = []
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--install') {
    options.install = true
    continue
  }
  if (arg === '--mode' || arg === '--cdp-endpoint') {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
      console.error(USAGE)
      process.exit(2)
    }
    if (arg === '--mode') options.mode = value
    else options.cdpEndpoint = value
    index += 1
    continue
  }
  if (arg.startsWith('-')) {
    console.error(USAGE)
    process.exit(2)
  }
  rest.push(arg)
}
if (rest.length > 1) {
  console.error(USAGE)
  process.exit(2)
}

// The plugin takes the engine checkout, the mode, and the endpoint from its configuration only; here
// the arguments stand in for it. This command imports nothing that needs a dependency installed — it
// is what runs when nothing else does — so the two rules the profile applies to these settings are
// applied here too, and refused the same way rather than passed on to fail later.
const projectPath = rest[0] ?? ''
const config = { projectPath, mode: options.mode, cdpEndpoint: options.cdpEndpoint.trim() }
if (config.mode !== 'launch' && config.mode !== 'attach') {
  console.error(`dsh-browser-use: mode must be "launch" or "attach"\n${USAGE}`)
  process.exit(2)
}
if (config.cdpEndpoint !== '' && !/^(?:https?|wss?):\/\/\S+$/u.test(config.cdpEndpoint)) {
  console.error(`dsh-browser-use: attach mode cdpEndpoint must be an http(s) or ws(s) URL without whitespace\n${USAGE}`)
  process.exit(2)
}

const report = options.install
  ? await ensureEngine(config, {
    install: true,
    fresh: true,
    onInstall: status => process.stderr.write(
      `installing the browser engine into ${status.environment}: with a Python 3.12+ this machine has, or uv when it has none\n`),
    onOutput: line => process.stderr.write(`  ${line}\n`),
  })
  : await inspectEngine(config, { fresh: true })
console.log(reportText(report, { Project: projectPath || '(unset)', Mode: config.mode }))
process.exit(report.ok ? 0 : 1)

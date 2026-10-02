#!/usr/bin/env node
/**
 * Check what this plugin needs before DSH ever calls it: the interpreter, the engine, and the browser.
 *
 * Run it right after installing the plugin, or in CI:
 *   node bin/doctor.mjs [--install] [/path/to/jev-ultrafast]
 * With --install, an engine this plugin installs itself is installed now (or the failed install
 * retried), with the installer's output on stderr. Exit status is 0 when the browser tools would
 * work, 1 when something named below has to be fixed, and 2 when the arguments are wrong.
 */

import { ensureEngine, inspectEngine, reportText } from '../lib/engine.js'

const USAGE = 'usage: node bin/doctor.mjs [--install] [/path/to/jev-ultrafast]'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
const install = args.includes('--install')
const rest = args.filter(arg => arg !== '--install')
if (rest.some(arg => arg.startsWith('-')) || rest.length > 1) {
  console.error(USAGE)
  process.exit(2)
}

// The plugin takes the engine checkout from its configuration only; here the argument stands in for it.
const projectPath = rest[0] ?? ''
const config = { projectPath, mode: 'launch' }

const report = install
  ? await ensureEngine(config, {
    install: true,
    fresh: true,
    onInstall: status => process.stderr.write(
      `installing the browser engine into ${status.environment}: with a Python 3.12+ this machine has, or uv when it has none\n`),
    onOutput: line => process.stderr.write(`  ${line}\n`),
  })
  : await inspectEngine(config, { fresh: true })
console.log(reportText(report, { Project: projectPath || '(unset)' }))
process.exit(report.ok ? 0 : 1)

#!/usr/bin/env node
/**
 * Check what this plugin needs before DSH ever calls it: the interpreter, the engine, and the browser.
 *
 * Run it right after installing the plugin, or in CI:
 *   node bin/doctor.mjs [/path/to/jev-ultrafast]
 * Exit status is 0 when the browser tools would work, 1 when something named below has to be fixed.
 */

import { inspectEngine, reportText } from '../lib/engine.js'

// The plugin takes the engine checkout from its configuration only; here the argument stands in for it.
const projectPath = process.argv[2] ?? ''

const report = await inspectEngine({ projectPath, mode: 'launch' }, { fresh: true })
console.log(reportText(report, { Project: projectPath || '(unset)' }))
process.exit(report.ok ? 0 : 1)

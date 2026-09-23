#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js'

await runCli('filebundle', process.argv.slice(2))

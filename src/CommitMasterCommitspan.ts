#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js'

await runCli('gitspan', process.argv.slice(2))

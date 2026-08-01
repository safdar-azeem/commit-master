#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js'

await runCli('gitbundle', process.argv.slice(2))

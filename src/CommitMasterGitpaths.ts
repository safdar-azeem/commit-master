#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js'

await runCli('gitpaths', process.argv.slice(2))

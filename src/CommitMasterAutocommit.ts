#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js'

await runCli('gitauto', process.argv.slice(2))

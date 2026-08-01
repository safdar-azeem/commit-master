#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js'

await runCli('gitstash', process.argv.slice(2))

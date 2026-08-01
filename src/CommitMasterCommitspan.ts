#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js';

await runCli('commitspan', process.argv.slice(2));

#!/usr/bin/env node
import { runCli } from './CommitMasterCli.js';

await runCli('autocommit', process.argv.slice(2));

import { createRequire } from 'node:module'
import { CommitMasterError } from './CommitMasterErrors.js'

const require = createRequire(import.meta.url)

const packages: Readonly<Record<string, string>> = {
   x64: 'commit-master-clipboard-linux-x64',
   arm64: 'commit-master-clipboard-linux-arm64',
}

/** Resolve only from this installed package's dependency tree, never the current project or PATH. */
export const resolveLinuxClipboardHelper = (
   platform: NodeJS.Platform = process.platform,
   arch: string = process.arch,
   resolve: (specifier: string) => string = require.resolve
): string => {
   if (platform !== 'linux') {
      throw new CommitMasterError(`File clipboard helper is not supported on ${platform}.`)
   }
   const packageName = packages[arch]
   if (!packageName) {
      throw new CommitMasterError(`Unsupported Linux architecture for file clipboard: ${arch}.`)
   }
   try {
      return resolve(`${packageName}/bin/commit-master-file-clipboard`)
   } catch (error) {
      throw new CommitMasterError(
         `The Commit Master Linux clipboard helper (${packageName}) is missing. Reinstall commit-master with optional dependencies enabled.`,
         { cause: error }
      )
   }
}

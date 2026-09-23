import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isBundleExcludedPath } from './CommitMasterChangedFiles.js'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import type { FileChange } from './CommitMasterTypes.js'

const normalizeRelativePath = (filePath: string): string => filePath.replaceAll(path.sep, '/')

const throwIfAborted = (signal?: AbortSignal): void => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
}

/** Collects bundle-eligible files without consulting Git or following symbolic links. */
export const collectEligibleDirectoryFiles = async (
   selectedRoot: string,
   signal?: AbortSignal
): Promise<{ root: string; files: FileChange[] }> => {
   throwIfAborted(signal)
   let root: string
   try {
      root = await realpath(selectedRoot)
      if (!(await lstat(root)).isDirectory()) {
         throw new CommitMasterError('The current path is not a directory.')
      }
   } catch (error) {
      if (error instanceof CommitMasterError || error instanceof ClipboardInterruptedError) throw error
      throw new CommitMasterError('Unable to access the current directory.', { cause: error })
   }

   const paths = new Set<string>()
   const scan = async (directory: string): Promise<void> => {
      throwIfAborted(signal)
      let entries
      try {
         const before = await lstat(directory)
         if (!before.isDirectory() || before.isSymbolicLink()) return
         entries = await readdir(directory, { withFileTypes: true })
         const after = await lstat(directory)
         // Do not consume entries from a directory that changed while it was read.
         if (
            !after.isDirectory() ||
            after.isSymbolicLink() ||
            after.dev !== before.dev ||
            after.ino !== before.ino
         ) {
            return
         }
      } catch (error) {
         if (error instanceof ClipboardInterruptedError) throw error
         throw new CommitMasterError('Unable to read a directory in the selected folder.', { cause: error })
      }
      for (const entry of entries) {
         throwIfAborted(signal)
         const absolutePath = path.join(directory, entry.name)
         const relativePath = normalizeRelativePath(path.relative(root, absolutePath))
         if (!relativePath || isBundleExcludedPath(relativePath)) continue
         if (entry.isDirectory()) {
            // Re-check before descending so a directory replaced by a link is still a leaf.
            let metadata
            try {
               metadata = await lstat(absolutePath)
            } catch (error) {
               const code = (error as NodeJS.ErrnoException).code
               if (code === 'ENOENT' || code === 'ENOTDIR') continue
               throw new CommitMasterError('Unable to inspect a directory in the selected folder.', {
                  cause: error,
               })
            }
            if (metadata.isSymbolicLink()) paths.add(relativePath)
            else if (metadata.isDirectory()) await scan(absolutePath)
         } else if (entry.isFile() || entry.isSymbolicLink()) {
            paths.add(relativePath)
         }
      }
   }
   await scan(root)
   return {
      root,
      files: [...paths].sort().map((filePath) => ({ kind: 'new', path: filePath })),
   }
}

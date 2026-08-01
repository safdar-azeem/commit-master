import { copyToClipboard } from './CommitMasterClipboard.js'
import { createMarkdownBundle } from './CommitMasterBundle.js'
import {
   collectEligibleChanges,
   escapeDisplayedPath,
   resolveAbsoluteChangedPath,
} from './CommitMasterChangedFiles.js'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import { resolveRepositoryRoot } from './CommitMasterRepository.js'

export type ClipboardCommandName = 'gitpaths' | 'gitbundle'
export type ClipboardWriter = (content: string, signal?: AbortSignal) => Promise<void>
export type BundleCreator = typeof createMarkdownBundle

export const clipboardSuccessMessage = (
   command: ClipboardCommandName,
   count: number
): string =>
   command === 'gitpaths'
      ? `${count} file paths copied.`
      : `${count} changed files bundled and copied.`

const throwIfCopyCancelled = (signal?: AbortSignal): void => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
}

export const runClipboardCommand = async (
   command: ClipboardCommandName,
   cwd: string,
   signal?: AbortSignal,
   writeClipboard: ClipboardWriter = copyToClipboard,
   buildBundle: BundleCreator = createMarkdownBundle
): Promise<void> => {
   throwIfCopyCancelled(signal)
   const repositoryRoot = await resolveRepositoryRoot(cwd)
   if (!repositoryRoot) {
      throw new CommitMasterError('The current directory is not inside a Git repository.')
   }

   const changes = await collectEligibleChanges(repositoryRoot)
   throwIfCopyCancelled(signal)
   if (changes.length === 0) {
      console.log('Nothing to copy. The working tree is clean.')
      return
   }

   const content =
      command === 'gitpaths'
         ? changes
              .map((change) =>
                 escapeDisplayedPath(resolveAbsoluteChangedPath(repositoryRoot, change.path))
              )
              .join('\n')
         : await buildBundle(repositoryRoot, changes, { signal })

   await writeClipboard(content, signal)
   console.log(clipboardSuccessMessage(command, changes.length))
}

import { copyToClipboard } from './CommitMasterClipboard.js'
import { createMarkdownBundle } from './CommitMasterBundle.js'
import {
   collectEligibleChanges,
   resolveAbsoluteChangedPath,
} from './CommitMasterChangedFiles.js'
import { CommitMasterError } from './CommitMasterErrors.js'
import { resolveRepositoryRoot } from './CommitMasterRepository.js'

export type ClipboardCommandName = 'gitpaths' | 'gitbundle'
export type ClipboardWriter = (content: string, signal?: AbortSignal) => Promise<void>

export const runClipboardCommand = async (
   command: ClipboardCommandName,
   cwd: string,
   signal?: AbortSignal,
   writeClipboard: ClipboardWriter = copyToClipboard
): Promise<void> => {
   const repositoryRoot = await resolveRepositoryRoot(cwd)
   if (!repositoryRoot) {
      throw new CommitMasterError('The current directory is not inside a Git repository.')
   }

   const changes = await collectEligibleChanges(repositoryRoot)
   if (changes.length === 0) {
      console.log('Nothing to copy. The working tree is clean.')
      return
   }

   const content =
      command === 'gitpaths'
         ? changes
              .map((change) => resolveAbsoluteChangedPath(repositoryRoot, change.path))
              .join('\n')
         : await createMarkdownBundle(repositoryRoot, changes)

   await writeClipboard(content, signal)
   console.log(
      command === 'gitpaths'
         ? `${changes.length} file paths copied.`
         : `${changes.length} changed files copied.`
   )
}

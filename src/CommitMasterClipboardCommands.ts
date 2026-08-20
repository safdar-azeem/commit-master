import { copyToClipboard } from './CommitMasterClipboard.js'
import path from 'node:path'
import { createCombinedMarkdownBundle, createMarkdownBundle } from './CommitMasterBundle.js'
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

   const changes = await collectEligibleChanges(
      repositoryRoot,
      command === 'gitbundle' ? 'bundle' : 'paths'
   )
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

export const runWorkspaceBundleCommand = async (
   repositoryRoots: readonly string[],
   signal?: AbortSignal,
   writeClipboard: ClipboardWriter = copyToClipboard
): Promise<void> => {
   throwIfCopyCancelled(signal)
   const repositories: Array<{
      root: string
      name: string
      changes: Awaited<ReturnType<typeof collectEligibleChanges>>
   }> = []
   for (const root of repositoryRoots) {
      throwIfCopyCancelled(signal)
      const changes = await collectEligibleChanges(root, 'bundle')
      repositories.push({ root, name: path.basename(root) || root, changes })
   }
   throwIfCopyCancelled(signal)

   const changedRepositories = repositories.filter((repository) => repository.changes.length > 0)
   for (const repository of repositories) {
      console.log(
         `${repository.name}: ${repository.changes.length === 0 ? 'clean' : `${repository.changes.length} changed files`}`
      )
   }
   if (changedRepositories.length === 0) {
      console.log('Nothing to copy. All selected repositories are clean.')
      return
   }

   const content = await createCombinedMarkdownBundle(changedRepositories, { signal })
   await writeClipboard(content, signal)
   const fileCount = changedRepositories.reduce(
      (total, repository) => total + repository.changes.length,
      0
   )
   console.log(
      `\n${fileCount} changed files from ${changedRepositories.length} ${
         changedRepositories.length === 1 ? 'repository' : 'repositories'
      } bundled and copied.`
   )
}

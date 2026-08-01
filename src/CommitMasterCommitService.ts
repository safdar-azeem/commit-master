import {
   CommitInterruptedError,
   CommitMasterError,
   CommitOutcomeUnknownError,
   FileCommitError,
} from './CommitMasterErrors.js'
import { runGit } from './CommitMasterGitRunner.js'
import type { InterruptionController } from './CommitMasterInterruption.js'
import { displayPath } from './CommitMasterMessages.js'
import { toGitDate } from './CommitMasterDates.js'
import type {
   CommitProgressCallbacks,
   CommitRequest,
   CommitResult,
   FileChange,
   RepositoryContext,
} from './CommitMasterTypes.js'

const affectedPaths = (change: FileChange): string[] =>
   change.kind === 'renamed' && change.previousPath
      ? [change.previousPath, change.path]
      : [change.path]

const sorted = (values: readonly string[]): string[] =>
   [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

const readStagedPaths = async (
   repository: RepositoryContext,
   category: string,
   signal?: AbortSignal
): Promise<string[]> => {
   const staged = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], {
      cwd: repository.root,
      category,
      signal,
   })
   return staged.stdout.toString('utf8').split('\0').filter(Boolean)
}

const verifyIsolatedIndex = async (
   repository: RepositoryContext,
   change: FileChange,
   signal: AbortSignal
): Promise<void> => {
   const actual = await readStagedPaths(
      repository,
      `Staging verification for "${displayPath(change)}"`,
      signal
   )
   const expected = affectedPaths(change)
   if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
      throw new CommitMasterError(
         `The staging area did not contain only the intended change for "${displayPath(change)}". Processing stopped without creating that commit.`
      )
   }
}

const stageChange = async (
   repository: RepositoryContext,
   change: FileChange,
   signal: AbortSignal
): Promise<void> => {
   await runGit(['add', '-A', '--', ...affectedPaths(change)], {
      cwd: repository.root,
      category: `Staging "${displayPath(change)}"`,
      signal,
   })
   await verifyIsolatedIndex(repository, change, signal)
}

const restoreCleanIndex = async (repository: RepositoryContext): Promise<void> => {
   const stagedPaths = await readStagedPaths(repository, 'Staging-area recovery inspection')
   if (stagedPaths.length === 0) return

   const head = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: repository.root,
      category: 'Recovery history lookup',
      acceptedExitCodes: [0, 128],
   })

   const chunkSize = 200
   for (let index = 0; index < stagedPaths.length; index += chunkSize) {
      const paths = stagedPaths.slice(index, index + chunkSize)
      const args =
         head.exitCode === 0
            ? ['reset', '--quiet', 'HEAD', '--', ...paths]
            : ['rm', '--cached', '--quiet', '--ignore-unmatch', '-r', '--', ...paths]
      await runGit(args, {
         cwd: repository.root,
         category:
            head.exitCode === 0
               ? 'Staging-area recovery'
               : 'Initial-repository staging-area recovery',
      })
   }

   const remaining = await readStagedPaths(repository, 'Staging-area recovery verification')
   if (remaining.length > 0) {
      throw new CommitMasterError(
         'Commit Master could not restore a clean staging area. Review the Git index before retrying.'
      )
   }
}

const cleanHookChanges = async (repository: RepositoryContext): Promise<number> => {
   const unexpected = await readStagedPaths(repository, 'Post-commit staging-area verification')
   if (unexpected.length > 0) await restoreCleanIndex(repository)
   return unexpected.length
}

const readHeadOid = async (
   repository: RepositoryContext,
   category: string
): Promise<string | undefined> => {
   const head = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: repository.root,
      category,
      acceptedExitCodes: [0, 128],
   })
   return head.exitCode === 0 ? head.stdout.toString('utf8').trim() : undefined
}

const verifyCommitCreated = async (
   repository: RepositoryContext,
   change: FileChange,
   previousHead: string | undefined
): Promise<boolean> => {
   let currentHead: string | undefined
   try {
      currentHead = await readHeadOid(
         repository,
         `Commit completion verification for "${displayPath(change)}"`
      )
   } catch (error) {
      throw new CommitOutcomeUnknownError(displayPath(change), error)
   }
   if (previousHead !== undefined && currentHead === undefined) {
      throw new CommitOutcomeUnknownError(
         displayPath(change),
         new CommitMasterError(
            'HEAD existed before git commit but could not be resolved afterward.'
         )
      )
   }
   return currentHead !== previousHead
}

const combineFailure = (original: unknown, cleanup: unknown): CommitMasterError => {
   const originalMessage = original instanceof Error ? original.message : String(original)
   const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup)
   return new CommitMasterError(
      `${originalMessage}\nStaging cleanup also failed: ${cleanupMessage}`,
      {
         cause: cleanup,
      }
   )
}

export const commitChanges = async (
   repository: RepositoryContext,
   requests: readonly CommitRequest[],
   progress: CommitProgressCallbacks,
   interruption: InterruptionController
): Promise<CommitResult> => {
   let created = 0
   let firstTimestamp: Date | undefined
   let lastTimestamp: Date | undefined
   let recoveredStagedEntries = 0

   for (const request of requests) {
      interruption.throwIfInterrupted(created, requests.length)
      progress.onStart(request, created, requests.length)
      let stagingAttempted = false
      let commitCreated = false

      try {
         stagingAttempted = true
         await stageChange(repository, request.change, interruption.signal)
         interruption.throwIfInterrupted(created, requests.length)

         const previousHead = await readHeadOid(
            repository,
            `Pre-commit HEAD snapshot for "${displayPath(request.change)}"`
         )

         const gitDate = request.timestamp ? toGitDate(request.timestamp) : undefined
         let commitFailure: unknown
         try {
            await runGit(
               ['commit', '-m', request.message, '--', ...affectedPaths(request.change)],
               {
                  cwd: repository.root,
                  category: `Committing "${displayPath(request.change)}"`,
                  env: gitDate
                     ? { GIT_AUTHOR_DATE: gitDate, GIT_COMMITTER_DATE: gitDate }
                     : undefined,
                  signal: interruption.signal,
               }
            )
         } catch (error) {
            commitFailure = error
         }

         commitCreated = await verifyCommitCreated(repository, request.change, previousHead)
         if (commitCreated) {
            created += 1
            if (request.timestamp) {
               firstTimestamp ??= request.timestamp
               lastTimestamp = request.timestamp
            }
            progress.onCommit(request, created, requests.length)
            recoveredStagedEntries += await cleanHookChanges(repository)
         }

         if (commitFailure !== undefined) throw commitFailure
         if (!commitCreated) {
            throw new CommitMasterError(
               `Git exited successfully for "${displayPath(request.change)}", but HEAD did not change. The commit was not recorded.`
            )
         }
         interruption.throwIfInterrupted(created, requests.length)
      } catch (error) {
         if (error instanceof CommitOutcomeUnknownError) throw error
         let failure: unknown = error
         let indexRestored = !stagingAttempted
         if (stagingAttempted) {
            try {
               await restoreCleanIndex(repository)
               indexRestored = true
            } catch (cleanupError) {
               indexRestored = false
               failure = combineFailure(error, cleanupError)
            }
         }

         if (interruption.isInterrupted() || error instanceof CommitInterruptedError) {
            throw new CommitInterruptedError(created, requests.length, {
               cause: failure,
               indexRestored,
            })
         }
         if (commitCreated) {
            const detail = failure instanceof Error ? failure.message : String(failure)
            const recovery = indexRestored
               ? 'The staging area was restored and working-tree changes were preserved.'
               : 'The staging area could not be fully restored. Review the Git index before retrying.'
            throw new CommitMasterError(
               `The commit for "${displayPath(request.change)}" was created, but post-commit safety processing failed.\n` +
                  `${detail}\nCreated ${created} commits before stopping.\n${recovery}`,
               { cause: failure }
            )
         }
         throw new FileCommitError(
            displayPath(request.change),
            created,
            requests.length,
            failure,
            indexRestored
         )
      }
   }
   return { created, firstTimestamp, lastTimestamp, recoveredStagedEntries }
}

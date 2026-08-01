import { escapeDisplayedPath } from './CommitMasterChangedFiles.js'
import {
   CommitMasterError,
   StashInterruptedError,
   StashOutcomeUnknownError,
} from './CommitMasterErrors.js'
import { gitText, runGit } from './CommitMasterGitRunner.js'
import {
   readChanges,
   resolveRepositoryRoot,
   validateRepositoryOperationState,
} from './CommitMasterRepository.js'

export const DEFAULT_STASH_TITLE = 'Commit Master stash'

interface TemporaryUnbornBase {
   branchReference: string
   commit: string
}

interface StashReferenceState {
   oid?: string
   reflogEntries: number
}

const readReference = async (root: string, reference: string): Promise<string | undefined> => {
   const result = await runGit(['rev-parse', '--verify', '--quiet', reference], {
      cwd: root,
      category: `${reference} verification`,
      acceptedExitCodes: [0, 1, 128],
   })
   return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined
}

const readStashReferenceState = async (root: string): Promise<StashReferenceState> => {
   const oid = await readReference(root, 'refs/stash')
   if (!oid) return { reflogEntries: 0 }
   const count = await gitText(
      ['rev-list', '--walk-reflogs', '--count', 'refs/stash'],
      {
         cwd: root,
         category: 'Stash history verification',
      }
   )
   const reflogEntries = Number(count)
   if (!Number.isSafeInteger(reflogEntries) || reflogEntries < 1) {
      throw new CommitMasterError('Git returned an invalid stash history count.')
   }
   return { oid, reflogEntries }
}

const createTemporaryUnbornBase = async (
   root: string
): Promise<TemporaryUnbornBase | undefined> => {
   if (await readReference(root, 'HEAD')) return undefined

   const branchReference = await gitText(['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: root,
      category: 'Unborn branch resolution',
   })
   const emptyTree = await gitText(['mktree'], {
      cwd: root,
      category: 'Temporary stash tree creation',
      input: '',
   })
   const commit = await gitText(
      ['commit-tree', emptyTree, '-m', 'Commit Master temporary stash base'],
      {
         cwd: root,
         category: 'Temporary stash base creation',
      }
   )
   await runGit(['update-ref', branchReference, commit, ''], {
      cwd: root,
      category: 'Temporary unborn branch preparation',
   })
   return { branchReference, commit }
}

const removeTemporaryUnbornBase = async (
   root: string,
   temporaryBase: TemporaryUnbornBase | undefined
): Promise<void> => {
   if (!temporaryBase) return
   await runGit(
      ['update-ref', '-d', temporaryBase.branchReference, temporaryBase.commit],
      {
         cwd: root,
         category: 'Temporary unborn branch cleanup',
      }
   )
}

const referenceChanged = (before: StashReferenceState, after: StashReferenceState): boolean =>
   after.oid !== undefined &&
   (after.oid !== before.oid || after.reflogEntries > before.reflogEntries)

export interface StashCommandResult {
   created: boolean
}

export const stashRepositoryChanges = async (
   root: string,
   title: string,
   signal?: AbortSignal
): Promise<StashCommandResult> => {
   await validateRepositoryOperationState(root)
   const initialChanges = await readChanges({ root })
   if (signal?.aborted) throw new StashInterruptedError(false, { cause: signal.reason })
   if (initialChanges.length === 0) return { created: false }

   const previousStash = await readStashReferenceState(root)
   let temporaryBase: TemporaryUnbornBase | undefined
   let operationError: unknown

   try {
      temporaryBase = await createTemporaryUnbornBase(root)
      await runGit(['stash', 'push', '--include-untracked', '--message', title], {
         cwd: root,
         category: 'Stash creation',
         signal,
      })
   } catch (error) {
      operationError = error
   }

   try {
      await removeTemporaryUnbornBase(root, temporaryBase)
   } catch (error) {
      throw new StashOutcomeUnknownError(error)
   }

   let currentStash: StashReferenceState
   try {
      currentStash = await readStashReferenceState(root)
   } catch (error) {
      throw new StashOutcomeUnknownError(error)
   }

   const created = referenceChanged(previousStash, currentStash)
   if (created) {
      let remainingChanges: Awaited<ReturnType<typeof readChanges>>
      try {
         remainingChanges = await readChanges({ root })
      } catch (error) {
         throw new StashOutcomeUnknownError(error)
      }
      if (remainingChanges.length === 0) return { created: true }
      if (signal?.aborted) throw new StashInterruptedError(true, { cause: operationError })
      const detail = operationError instanceof Error ? `\n${operationError.message}` : ''
      throw new CommitMasterError(
         'A new stash was created, but the working tree is not clean. Inspect "git stash list" and "git status" before continuing.' +
            detail,
         { cause: operationError }
      )
   }

   if (signal?.aborted) throw new StashInterruptedError(false, { cause: operationError })
   if (operationError) throw operationError

   const remainingChanges = await readChanges({ root })
   if (remainingChanges.length === 0) return { created: false }
   throw new CommitMasterError('Git did not create a stash. Working-tree changes were preserved.')
}

export const runStashCommand = async (
   cwd: string,
   title: string,
   customTitle: boolean,
   signal?: AbortSignal
): Promise<void> => {
   const root = await resolveRepositoryRoot(cwd)
   if (!root) throw new CommitMasterError('The current directory is not inside a Git repository.')

   const result = await stashRepositoryChanges(root, title, signal)
   if (!result.created) {
      console.log('Nothing to stash. The working tree is clean.')
      return
   }
   console.log(
      customTitle
         ? `Changes stashed successfully: ${escapeDisplayedPath(title)}`
         : 'Changes stashed successfully.'
   )
}

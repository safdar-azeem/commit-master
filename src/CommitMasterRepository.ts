import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CommitMasterError, GitCommandError } from './CommitMasterErrors.js'
import { gitText, runGit } from './CommitMasterGitRunner.js'
import {
   mergeContentIdenticalRenames,
   mergeDetectedRenames,
   parseWorkingTreeStatus,
} from './CommitMasterStatus.js'
import type { FileChange, RepositoryContext } from './CommitMasterTypes.js'

const exists = async (target: string): Promise<boolean> => {
   try {
      await access(target)
      return true
   } catch {
      return false
   }
}

export const resolveRepositoryRoot = async (cwd: string): Promise<string | undefined> => {
   try {
      return await gitText(['rev-parse', '--show-toplevel'], {
         cwd,
         category: 'Repository resolution',
         env: { LANG: 'C', LC_ALL: 'C' },
      })
   } catch (error) {
      if (error instanceof GitCommandError && error.stderr.includes('not a git repository')) {
         return undefined
      }
      throw error
   }
}

export const initializeRepository = async (cwd: string): Promise<void> => {
   const existingRoot = await resolveRepositoryRoot(cwd)
   if (existingRoot) return

   await runGit(['init', '--quiet'], {
      cwd,
      category: 'Git initialization',
   })
   const initializedRoot = await resolveRepositoryRoot(cwd)
   if (!initializedRoot) {
      throw new CommitMasterError(
         'Git initialization completed, but the new repository could not be resolved.'
      )
   }
}

export const validateRepositoryOperationState = async (root: string): Promise<void> => {
   const gitDirectory = await gitText(['rev-parse', '--absolute-git-dir'], {
      cwd: root,
      category: 'Git directory resolution',
   })
   const markers: ReadonlyArray<readonly [string, string]> = [
      ['MERGE_HEAD', 'merge'],
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['sequencer', 'sequenced cherry-pick or revert'],
      ['BISECT_START', 'bisect'],
   ]
   for (const [marker, operation] of markers) {
      if (await exists(path.join(gitDirectory, marker))) {
         throw new CommitMasterError(
            `A Git ${operation} operation is in progress. Complete or abort it before running Commit Master.`
         )
      }
   }

   const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], {
      cwd: root,
      category: 'Conflict validation',
   })
   if (conflicts.stdout.length > 0) {
      throw new CommitMasterError(
         'The repository contains unresolved conflicts. Resolve them before running Commit Master.'
      )
   }
}

const validateAttachedHead = async (root: string): Promise<void> => {
   const branch = await runGit(['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: root,
      category: 'Branch validation',
      acceptedExitCodes: [0, 1],
   })
   if (branch.exitCode !== 0) {
      throw new CommitMasterError(
         'The repository is in detached HEAD state. Check out a branch before running Commit Master.'
      )
   }
}

const validateCleanIndex = async (root: string): Promise<void> => {
   const staged = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], {
      cwd: root,
      category: 'Staging-area validation',
   })
   if (staged.stdout.length > 0) {
      throw new CommitMasterError(
         'The staging area already contains changes. Commit or unstage them before running Commit Master; the existing index was left unchanged.'
      )
   }
}

const validateIdentity = async (root: string): Promise<void> => {
   try {
      await gitText(['var', 'GIT_AUTHOR_IDENT'], {
         cwd: root,
         category: 'Git author identity validation',
      })
      await gitText(['var', 'GIT_COMMITTER_IDENT'], {
         cwd: root,
         category: 'Git committer identity validation',
      })
   } catch (error) {
      if (error instanceof GitCommandError) {
         throw new CommitMasterError(
            'Git author information is not configured. Set user.name and user.email in Git, then run the command again.',
            { cause: error }
         )
      }
      throw error
   }
}

const getHeadTimestamp = async (root: string): Promise<number | undefined> => {
   const head = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      category: 'Commit history validation',
      acceptedExitCodes: [0, 128],
   })
   if (head.exitCode !== 0) return undefined
   const timestamp = await gitText(['show', '-s', '--format=%ct', 'HEAD'], {
      cwd: root,
      category: 'Latest commit timestamp lookup',
   })
   const parsed = Number(timestamp)
   if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new CommitMasterError('Git returned an invalid timestamp for the latest commit.')
   }
   return parsed
}

const detectInPlaceProgressSafety = async (root: string): Promise<boolean> => {
   try {
      const signing = await runGit(['config', '--bool', '--get', 'commit.gpgSign'], {
         cwd: root,
         category: 'Commit-signing progress check',
         acceptedExitCodes: [0, 1],
      })
      if (signing.exitCode === 0 && signing.stdout.toString('utf8').trim() === 'true') return false

      const gitDirectory = await gitText(['rev-parse', '--absolute-git-dir'], {
         cwd: root,
         category: 'Hook-directory progress check',
      })
      const configuredHooks = await runGit(['config', '--path', '--get', 'core.hooksPath'], {
         cwd: root,
         category: 'Hook-path progress check',
         acceptedExitCodes: [0, 1],
      })
      const configuredPath = configuredHooks.stdout.toString('utf8').trim()
      const hooksDirectory = configuredPath
         ? path.resolve(root, configuredPath)
         : path.join(gitDirectory, 'hooks')
      const commitHooks = [
         'pre-commit',
         'prepare-commit-msg',
         'commit-msg',
         'post-commit',
         'post-rewrite',
      ]
      for (const hook of commitHooks) {
         if (await exists(path.join(hooksDirectory, hook))) return false
      }
      return true
   } catch {
      return false
   }
}

export const prepareRepository = async (cwd: string): Promise<RepositoryContext> => {
   const root = await resolveRepositoryRoot(cwd)
   if (!root) throw new CommitMasterError('The current directory is not inside a Git repository.')
   await validateRepositoryOperationState(root)
   await validateAttachedHead(root)
   await validateCleanIndex(root)
   const headTimestampSeconds = await getHeadTimestamp(root)
   const inPlaceProgressSafe = await detectInPlaceProgressSafety(root)
   return { root, name: path.basename(root) || root, headTimestampSeconds, inPlaceProgressSafe }
}

export const validateCommitReadiness = async (
   repository: RepositoryContext,
   executionTime: Date
): Promise<void> => {
   await validateIdentity(repository.root)
   const { headTimestampSeconds } = repository
   if (
      headTimestampSeconds !== undefined &&
      headTimestampSeconds * 1000 > executionTime.getTime()
   ) {
      throw new CommitMasterError(
         'The latest commit is dated in the future. Commit Master cannot create chronologically ordered commits without rewriting history.'
      )
   }
}

const blobIdForHeadPath = async (root: string, relativePath: string): Promise<string | undefined> => {
   const result = await runGit(['rev-parse', '--verify', `HEAD:${relativePath}`], {
      cwd: root,
      category: 'Rename content lookup',
      acceptedExitCodes: [0, 128],
   })
   if (result.exitCode !== 0) return undefined
   const oid = result.stdout.toString('utf8').trim()
   return oid || undefined
}

const blobIdForWorktreePath = async (
   root: string,
   relativePath: string
): Promise<string | undefined> => {
   try {
      const oid = await gitText(['hash-object', '--', relativePath], {
         cwd: root,
         category: 'Rename content lookup',
      })
      return oid || undefined
   } catch {
      return undefined
   }
}

const nulSeparatedPaths = (changes: readonly FileChange[]): Buffer =>
   Buffer.from(`${changes.map((change) => change.path).join('\0')}\0`)

const parseDetectedRenameStatus = (output: Buffer): FileChange[] => {
   const fields = output.toString('utf8').split('\0')
   const renames: FileChange[] = []
   for (let index = 0; index < fields.length; index += 1) {
      const status = fields[index]
      if (!status) continue
      if (status.startsWith('R')) {
         const previousPath = fields[index + 1]
         const path = fields[index + 2]
         if (!previousPath || !path) {
            throw new CommitMasterError('Git returned an incomplete rename-detection record.')
         }
         renames.push({ kind: 'renamed', path, previousPath })
         index += 2
      } else {
         index += 1
      }
   }
   return renames
}

const detectUnstagedRenames = async (
   root: string,
   deleted: readonly FileChange[],
   created: readonly FileChange[]
): Promise<FileChange[]> => {
   const head = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      category: 'Rename detection',
      acceptedExitCodes: [0, 128],
   })
   if (head.exitCode !== 0) return []

   const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'commit-master-rename-index-'))
   const temporaryIndex = path.join(temporaryDirectory, 'index')
   const env = { GIT_INDEX_FILE: temporaryIndex }
   try {
      await runGit(['read-tree', 'HEAD'], {
         cwd: root,
         category: 'Rename detection',
         env,
      })
      await runGit(['update-index', '--remove', '-z', '--stdin'], {
         cwd: root,
         category: 'Rename detection',
         env,
         input: nulSeparatedPaths(deleted),
      })
      await runGit(['update-index', '--add', '-z', '--stdin'], {
         cwd: root,
         category: 'Rename detection',
         env,
         input: nulSeparatedPaths(created),
      })
      const detected = await runGit(
         ['diff-index', '--cached', '--name-status', '-z', '--find-renames=50%', 'HEAD'],
         {
            cwd: root,
            category: 'Rename detection',
            env,
         }
      )
      return parseDetectedRenameStatus(detected.stdout)
   } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
   }
}

const resolveUnstagedRenames = async (
   root: string,
   changes: FileChange[]
): Promise<FileChange[]> => {
   const deleted = changes.filter((change) => change.kind === 'deleted')
   const created = changes.filter((change) => change.kind === 'new')
   if (deleted.length === 0 || created.length === 0) return changes

   const detectedRenames = await detectUnstagedRenames(root, deleted, created)
   const withDetectedRenames = mergeDetectedRenames(changes, detectedRenames)
   const unpairedDeleted = withDetectedRenames.filter((change) => change.kind === 'deleted')
   const unpairedCreated = withDetectedRenames.filter((change) => change.kind === 'new')
   if (unpairedDeleted.length === 0 || unpairedCreated.length === 0) return withDetectedRenames

   const deletedBlobIds = new Map<string, string>()
   const createdBlobIds = new Map<string, string>()
   await Promise.all(
      unpairedDeleted.map(async (change) => {
         const oid = await blobIdForHeadPath(root, change.path)
         if (oid) deletedBlobIds.set(change.path, oid)
      })
   )
   await Promise.all(
      unpairedCreated.map(async (change) => {
         const oid = await blobIdForWorktreePath(root, change.path)
         if (oid) createdBlobIds.set(change.path, oid)
      })
   )
   return mergeContentIdenticalRenames(withDetectedRenames, deletedBlobIds, createdBlobIds)
}

const identifyContentUnchangedRenames = async (
   root: string,
   changes: readonly FileChange[]
): Promise<FileChange[]> =>
   Promise.all(
      changes.map(async (change) => {
         if (change.kind !== 'renamed' || !change.previousPath) return change
         const [previousBlobId, currentBlobId] = await Promise.all([
            blobIdForHeadPath(root, change.previousPath),
            blobIdForWorktreePath(root, change.path),
         ])
         return previousBlobId && previousBlobId === currentBlobId
            ? { ...change, isContentUnchanged: true }
            : change
      })
   )

export const readChanges = async (repository: Pick<RepositoryContext, 'root'>): Promise<FileChange[]> => {
   const status = await runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'],
      {
         cwd: repository.root,
         category: 'Working-tree inspection',
      }
   )
   const changes = await resolveUnstagedRenames(repository.root, parseWorkingTreeStatus(status.stdout))
   return identifyContentUnchangedRenames(repository.root, changes)
}

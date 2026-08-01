import { access } from 'node:fs/promises'
import path from 'node:path'
import { CommitMasterError, GitCommandError } from './CommitMasterErrors.js'
import { gitText, runGit } from './CommitMasterGitRunner.js'
import { parseWorkingTreeStatus } from './CommitMasterStatus.js'
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

const validateOperationState = async (root: string): Promise<void> => {
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
   await validateOperationState(root)
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

export const readChanges = async (repository: Pick<RepositoryContext, 'root'>): Promise<FileChange[]> => {
   const status = await runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'],
      {
         cwd: repository.root,
         category: 'Working-tree inspection',
      }
   )
   return parseWorkingTreeStatus(status.stdout)
}

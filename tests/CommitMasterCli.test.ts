import assert from 'node:assert/strict'
import {
   access,
   chmod,
   mkdir,
   mkdtemp,
   realpath,
   rename,
   rm,
   unlink,
   writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
   createProgressBar,
   createProgressSection,
   progressPercentage,
} from '../dist/CommitMasterProgress.js'
import { createProgressHeader } from '../dist/CommitMasterOutput.js'
import { createCommitMessage } from '../dist/CommitMasterMessages.js'
import { ensureGitRepository } from '../dist/CommitMasterBootstrap.js'
import { InterruptionController } from '../dist/CommitMasterInterruption.js'
import { confirmGitInitialization, parseConfirmationAnswer } from '../dist/CommitMasterPrompt.js'

const commitspanBinary = fileURLToPath(
   new URL('../dist/CommitMasterCommitspan.js', import.meta.url)
)
const autocommitBinary = fileURLToPath(
   new URL('../dist/CommitMasterAutocommit.js', import.meta.url)
)
const temporaryPaths = new Set<string>()

interface CommandResult {
   status: number | null
   stdout: string
   stderr: string
}

const execute = (
   command: string,
   args: readonly string[],
   cwd: string,
   environment?: NodeJS.ProcessEnv
): CommandResult => {
   const result = spawnSync(command, [...args], {
      cwd,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      windowsHide: true,
   })
   if (result.error) throw result.error
   return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const git = (repository: string, args: readonly string[]): string => {
   const result = execute('git', args, repository)
   if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
   }
   return result.stdout.trim()
}

const createRepository = async (): Promise<string> => {
   const repository = await mkdtemp(join(tmpdir(), 'commit-master-test-'))
   temporaryPaths.add(repository)
   git(repository, ['init', '--quiet'])
   git(repository, ['config', 'user.name', 'Commit Master Test'])
   git(repository, ['config', 'user.email', 'commit-master@example.invalid'])
   git(repository, ['config', 'commit.gpgSign', 'false'])
   return repository
}

const createProject = async (): Promise<string> => {
   const project = await mkdtemp(join(tmpdir(), 'commit-master-project-'))
   temporaryPaths.add(project)
   return project
}

const writeRepositoryFile = async (
   repository: string,
   relativePath: string,
   contents: string
): Promise<void> => {
   const target = join(repository, relativePath)
   await mkdir(dirname(target), { recursive: true })
   await writeFile(target, contents, 'utf8')
}

const createBaselineCommit = async (
   repository: string,
   files: Record<string, string>
): Promise<void> => {
   for (const [file, contents] of Object.entries(files))
      await writeRepositoryFile(repository, file, contents)
   git(repository, ['add', '--all'])
   git(repository, ['commit', '--quiet', '-m', 'Baseline'])
}

const runCli = (
   repository: string,
   command: 'commitspan' | 'autocommit',
   args: readonly string[] = [],
   environment?: NodeJS.ProcessEnv
): CommandResult =>
   execute(
      process.execPath,
      [command === 'commitspan' ? commitspanBinary : autocommitBinary, ...args],
      repository,
      {
         CI: '1',
         TERM: 'dumb',
         ...environment,
      }
   )

const commitCount = (repository: string): number => {
   const result = execute('git', ['rev-list', '--count', 'HEAD'], repository)
   return result.status === 0 ? Number(result.stdout.trim()) : 0
}

const stagedPaths = (repository: string): string =>
   git(repository, ['diff', '--cached', '--name-only', '--no-renames'])

const installHook = async (repository: string, name: string, body: string): Promise<void> => {
   const hooksDirectory = git(repository, ['rev-parse', '--git-path', 'hooks'])
   const hookPath = join(repository, hooksDirectory, name)
   await mkdir(dirname(hookPath), { recursive: true })
   await writeFile(hookPath, `#!/bin/sh\nset -eu\n${body}\n`, 'utf8')
   await chmod(hookPath, 0o755)
}

afterEach(async () => {
   for (const target of temporaryPaths) await rm(target, { recursive: true, force: true })
   temporaryPaths.clear()
})

describe('Git initialization', () => {
   it('accepts Enter and Yes while rejecting No and invalid answers correctly', () => {
      assert.equal(parseConfirmationAnswer(''), 'yes')
      assert.equal(parseConfirmationAnswer('Y'), 'yes')
      assert.equal(parseConfirmationAnswer('yes'), 'yes')
      assert.equal(parseConfirmationAnswer('N'), 'no')
      assert.equal(parseConfirmationAnswer('no'), 'no')
      assert.equal(parseConfirmationAnswer('later'), 'invalid')
   })

   it('uses Enter as the interactive default confirmation', async () => {
      const input = Object.assign(new PassThrough(), { isTTY: true })
      const output = Object.assign(new PassThrough(), { isTTY: true })
      let rendered = ''
      output.on('data', (chunk: Buffer) => {
         rendered += chunk.toString('utf8')
      })
      const confirmation = confirmGitInitialization(new InterruptionController(), {
         input,
         output,
         environment: {},
      })
      input.end('\n')

      assert.equal(await confirmation, true)
      assert.match(rendered, /Git is not initialized in this project\./)
      assert.match(rendered, /Initialize it now\? \(Y\/n\)/)
   })

   it('initializes an unborn repository after confirmation and supports immediate autocommit', async () => {
      const project = await createProject()
      await writeRepositoryFile(project, 'src/first.ts', 'first\n')
      const interruption = new InterruptionController()

      assert.equal(await ensureGitRepository(project, interruption, async () => true), true)
      assert.equal(
         await realpath(git(project, ['rev-parse', '--show-toplevel'])),
         await realpath(project)
      )
      git(project, ['config', 'user.name', 'Commit Master Test'])
      git(project, ['config', 'user.email', 'commit-master@example.invalid'])

      const result = runCli(project, 'autocommit')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(project), 1)
      assert.equal(git(project, ['status', '--porcelain']), '')
   })

   it('supports commitspan immediately after initializing an unborn repository', async () => {
      const project = await createProject()
      await writeRepositoryFile(project, 'src/first.ts', 'first\n')
      await writeRepositoryFile(project, 'src/second.ts', 'second\n')
      assert.equal(
         await ensureGitRepository(project, new InterruptionController(), async () => true),
         true
      )
      git(project, ['config', 'user.name', 'Commit Master Test'])
      git(project, ['config', 'user.email', 'commit-master@example.invalid'])

      const result = runCli(project, 'commitspan', ['10', '5'])
      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(project), 2)
      assert.equal(git(project, ['status', '--porcelain']), '')
   })

   it('declines initialization without creating repository metadata', async () => {
      const project = await createProject()
      const initialized = await ensureGitRepository(
         project,
         new InterruptionController(),
         async () => false
      )

      assert.equal(initialized, false)
      await assert.rejects(access(join(project, '.git')))
   })

   it('refuses to initialize or wait in non-interactive autocommit and commitspan runs', async () => {
      for (const [command, args] of [
         ['autocommit', []],
         ['commitspan', ['10', '5']],
      ] as const) {
         const project = await createProject()
         await writeRepositoryFile(project, 'first.ts', 'first\n')
         const result = runCli(project, command, args)
         assert.notEqual(result.status, 0)
         assert.match(result.stderr, /Git is not initialized in this project\./)
         assert.match(result.stderr, /Initialize Git before running Commit Master\./)
         await assert.rejects(access(join(project, '.git')))
      }
   })

   it('bypasses confirmation for an existing repository', async () => {
      const repository = await createRepository()
      let prompted = false
      assert.equal(
         await ensureGitRepository(repository, new InterruptionController(), async () => {
            prompted = true
            return false
         }),
         true
      )
      assert.equal(prompted, false)
   })
})

describe('commitspan', () => {
   it('expands 10 days to 12 and creates 58 chronological commits', async () => {
      const repository = await createRepository()
      for (let index = 0; index < 58; index += 1) {
         await writeRepositoryFile(
            repository,
            `src/file-${String(index).padStart(2, '0')}.ts`,
            `${index}\n`
         )
      }

      const before = Math.floor(Date.now() / 1000)
      const result = runCli(repository, 'commitspan', ['10', '5'])
      const after = Math.ceil(Date.now() / 1000)

      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(repository), 58)
      assert.match(result.stdout, /58 commits · 12 days · 5\/day/)
      assert.equal((result.stdout.match(/commit-master-test-/g) ?? []).length, 1)
      assert.doesNotMatch(result.stdout, /Completed successfully|Created commits:/)

      const timestamps = git(repository, ['log', '--reverse', '--format=%at'])
         .split('\n')
         .map(Number)
      assert.equal(timestamps.length, 58)
      for (let index = 1; index < timestamps.length; index += 1) {
         assert.ok((timestamps[index] ?? 0) >= (timestamps[index - 1] ?? 0))
      }
      assert.ok((timestamps.at(-1) ?? 0) <= after)
      assert.ok((timestamps.at(-1) ?? 0) >= before - 12 * 24 * 60 * 60)

      const dates = git(repository, [
         'log',
         '--reverse',
         '--format=%ad',
         '--date=format-local:%Y-%m-%d',
      ]).split('\n')
      const perDay = new Map<string, number>()
      for (const date of dates) perDay.set(date, (perDay.get(date) ?? 0) + 1)
      assert.equal(perDay.size, 12)
      for (const count of perDay.values()) assert.ok(count <= 5)
   })

   it('reports the repository and clean working tree on a second run', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'one.ts', 'one\n')
      assert.equal(runCli(repository, 'commitspan', ['10', '5']).status, 0)

      const clean = runCli(repository, 'commitspan', ['10', '5'])
      assert.equal(clean.status, 0, clean.stderr)
      assert.match(clean.stdout, /commit-master-test-/)
      assert.match(clean.stdout, /Nothing to commit\. The working tree is clean\./)
   })
})

describe('change classification and paths', () => {
   it('commits modified, deleted, renamed, untracked, spaced, Unicode, and leading-dash paths separately', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, {
         'modified.ts': 'before\n',
         'deleted.ts': 'delete\n',
         'old-name.ts': 'rename\n',
      })
      await writeRepositoryFile(repository, 'modified.ts', 'after\n')
      await unlink(join(repository, 'deleted.ts'))
      await rename(join(repository, 'old-name.ts'), join(repository, 'new-name.ts'))
      await writeRepositoryFile(repository, 'new file.ts', 'space\n')
      await writeRepositoryFile(repository, 'src/ümlaut.ts', 'unicode\n')
      await writeRepositoryFile(repository, '-feature.ts', 'dash\n')

      const result = runCli(repository, 'autocommit')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(repository), 7)
      assert.equal(git(repository, ['status', '--porcelain']), '')
      const messages = git(repository, ['log', '--format=%s', '-6'])
      assert.match(messages, /Update modified\.ts/)
      assert.match(messages, /Delete deleted\.ts/)
      assert.match(messages, /Rename old-name\.ts to new-name\.ts/)
      assert.match(messages, /Add new file\.ts/)
      assert.match(messages, /Add ümlaut\.ts/)
      assert.match(messages, /Add -feature\.ts/)
      assert.doesNotMatch(messages, /Add src\//)
   })
})

describe('HEAD verification and recovery', () => {
   it('restores the index when a pre-commit hook fails before HEAD changes', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'tracked.ts': 'before\n' })
      await writeRepositoryFile(repository, 'tracked.ts', 'after\n')
      await installHook(
         repository,
         'pre-commit',
         "printf 'hook change\\n' > hook-generated.txt\ngit add -- hook-generated.txt\necho 'pre-commit hook failed' >&2\nexit 1"
      )
      const before = commitCount(repository)

      const result = runCli(repository, 'autocommit')

      assert.notEqual(result.status, 0)
      assert.equal(commitCount(repository), before)
      assert.equal(stagedPaths(repository), '')
      assert.match(git(repository, ['status', '--porcelain']), /tracked\.ts/)
      assert.match(git(repository, ['status', '--porcelain']), /hook-generated\.txt/)
      assert.match(result.stderr, /pre-commit hook failed/)
      assert.match(result.stderr, /Created commits: 0/)
   })

   it('keeps a commit when a post-commit hook exits unsuccessfully after HEAD changes', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'created.ts', 'created\n')
      await installHook(repository, 'post-commit', "echo 'post-commit hook failed' >&2\nexit 1")

      const result = runCli(repository, 'autocommit')

      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(repository), 1)
      assert.equal(stagedPaths(repository), '')
   })

   it(
      'counts HEAD as created when the Git process reports failure after a post-commit hook ran',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         await installHook(repository, 'post-commit', 'touch .post-hook-ran\nexit 1')
         const wrapperDirectory = await mkdtemp(join(tmpdir(), 'commit-master-post-hook-wrapper-'))
         temporaryPaths.add(wrapperDirectory)
         const realGit = execute('sh', ['-c', 'command -v git'], repository).stdout.trim()
         const wrapper = join(wrapperDirectory, 'git')
         await writeFile(
            wrapper,
            '#!/bin/sh\n"$REAL_GIT" "$@"\nSTATUS=$?\nif [ "$1" = "commit" ] && [ -f .post-hook-ran ]; then echo "post-commit processing failed" >&2; exit 1; fi\nexit "$STATUS"\n',
            'utf8'
         )
         await chmod(wrapper, 0o755)

         const result = runCli(repository, 'autocommit', [], {
            PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
            REAL_GIT: realGit,
         })

         assert.notEqual(result.status, 0)
         assert.equal(commitCount(repository), 1)
         assert.equal(stagedPaths(repository), '')
         assert.match(result.stderr, /post-commit processing failed/)
         assert.match(result.stderr, /Created 1 commits before stopping/)
      }
   )

   it('cleans hook-generated staged changes while retaining working-tree content', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'created.ts', 'created\n')
      await installHook(
         repository,
         'post-commit',
         "printf 'generated by hook\\n' > hook-generated.txt\ngit add -- hook-generated.txt"
      )

      const result = runCli(repository, 'autocommit')

      assert.equal(result.status, 0, result.stderr)
      assert.equal(stagedPaths(repository), '')
      assert.match(git(repository, ['status', '--porcelain']), /hook-generated\.txt/)
      assert.match(result.stdout, /Recovered unexpected staged paths/)
   })

   it(
      'interrupts during staging without creating a commit or retaining staged entries',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         const wrapperDirectory = await mkdtemp(join(tmpdir(), 'commit-master-git-wrapper-'))
         temporaryPaths.add(wrapperDirectory)
         const realGit = execute('sh', ['-c', 'command -v git'], repository).stdout.trim()
         const wrapper = join(wrapperDirectory, 'git')
         await writeFile(
            wrapper,
            '#!/bin/sh\nif [ "$1" = "add" ]; then kill -INT "$PPID"; exit 130; fi\nexec "$REAL_GIT" "$@"\n',
            'utf8'
         )
         await chmod(wrapper, 0o755)

         const result = runCli(repository, 'autocommit', [], {
            PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
            REAL_GIT: realGit,
         })

         assert.equal(result.status, 130)
         assert.equal(commitCount(repository), 0)
         assert.equal(stagedPaths(repository), '')
         assert.match(git(repository, ['status', '--porcelain']), /created\.ts/)
      }
   )

   it(
      'interrupts during git commit before HEAD changes and restores the index',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         await installHook(
            repository,
            'pre-commit',
            'CLI_PID=$(ps -o ppid= -p "$PPID" | tr -d \' \')\nkill -INT "$CLI_PID"\nexit 1'
         )

         const result = runCli(repository, 'autocommit')

         assert.equal(result.status, 130)
         assert.equal(commitCount(repository), 0)
         assert.equal(stagedPaths(repository), '')
         assert.match(`${result.stdout}\n${result.stderr}`, /Created commits: 0/)
         assert.match(`${result.stdout}\n${result.stderr}`, /Remaining changes: 1/)
      }
   )

   it(
      'uses post-commit HEAD when Ctrl+C arrives immediately after commit creation',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         await installHook(
            repository,
            'post-commit',
            'CLI_PID=$(ps -o ppid= -p "$PPID" | tr -d \' \')\nkill -INT "$CLI_PID"\nexit 1'
         )

         const result = runCli(repository, 'autocommit')

         assert.equal(commitCount(repository), 1)
         assert.equal(stagedPaths(repository), '')
         assert.match(`${result.stdout}\n${result.stderr}`, /Created commits: 1/)
         assert.match(`${result.stdout}\n${result.stderr}`, /Remaining changes: 0/)
      }
   )
})

describe('output and timestamps', () => {
   it('builds compact running and completed progress sections', () => {
      const repository = {
         root: '/repository',
         name: 'network-logger',
         inPlaceProgressSafe: true,
      }
      const header = createProgressHeader(repository, 58, {
         requestedDuration: 10,
         effectiveDuration: 12,
         commitsPerDay: 5,
         startDate: new Date(2026, 6, 21),
         endDate: new Date(2026, 7, 1),
      })
      assert.deepEqual(header.slice(0, 2), ['network-logger', '58 commits · 12 days · 5/day'])
      assert.equal(header.join('\n').match(/network-logger/g)?.length, 1)
      assert.deepEqual(createProgressSection(34, 58, 'Running', 'Update network.ts').slice(-2), [
         'Current: Update network.ts',
         'Status: Running',
      ])
      const completed = createProgressSection(58, 58, 'Completed', '')
      assert.equal(completed.at(0), `Progress: ${createProgressBar(58, 58)} 100%`)
      assert.equal(completed.at(-1), 'Status: Completed')
      assert.doesNotMatch(completed.join('\n'), /Current:/)
      assert.equal(progressPercentage(34, 58), 59)
      assert.deepEqual(createProgressHeader(repository, 18), [])
   })

   it('uses final file names for every shared commit-message type', () => {
      assert.equal(
         createCommitMessage({ kind: 'new', path: 'src/services/NewFile.ts' }),
         'Add NewFile.ts'
      )
      assert.equal(
         createCommitMessage({ kind: 'modified', path: 'src/services/CommitService.ts' }),
         'Update CommitService.ts'
      )
      assert.equal(
         createCommitMessage({ kind: 'deleted', path: 'config/legacy.config.ts' }),
         'Delete legacy.config.ts'
      )
      assert.equal(
         createCommitMessage({
            kind: 'renamed',
            path: 'src/new/NewName.ts',
            previousPath: 'src/old/OldName.ts',
         }),
         'Rename OldName.ts to NewName.ts'
      )
      assert.equal(
         createCommitMessage({ kind: 'new', path: 'src\\nested\\WindowsFile.ts' }),
         'Add WindowsFile.ts'
      )
      const message = createCommitMessage({
         kind: 'modified',
         path: 'src/modules/CommitMasterCli.ts',
      })
      assert.equal(
         createProgressSection(3, 10, 'Running', message)[1],
         'Current: Update CommitMasterCli.ts'
      )
   })

   it('uses cursor-free output when stdout is non-interactive', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'created.ts', 'created\n')

      const result = runCli(repository, 'autocommit')

      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout, /\u001b\[/)
      assert.equal((result.stdout.match(/commit-master-test-/g) ?? []).length, 0)
      assert.doesNotMatch(result.stdout, /Commit Master|Completed successfully|Created commits:/)
   })

   it('uses current author and committer timestamps for autocommit', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'created.ts', 'created\n')
      const before = Math.floor(Date.now() / 1000)

      const result = runCli(repository, 'autocommit')
      const after = Math.ceil(Date.now() / 1000)

      assert.equal(result.status, 0, result.stderr)
      const [author, committer] = git(repository, ['log', '-1', '--format=%at %ct'])
         .split(' ')
         .map(Number)
      assert.ok((author ?? 0) >= before && (author ?? 0) <= after)
      assert.ok((committer ?? 0) >= before && (committer ?? 0) <= after)
   })
})

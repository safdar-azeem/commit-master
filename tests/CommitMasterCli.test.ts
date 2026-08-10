import assert from 'node:assert/strict'
import {
   access,
   chmod,
   mkdir,
   mkdtemp,
   readFile,
   realpath,
   rename,
   rm,
   symlink,
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
import {
   MAX_BUNDLE_BYTES,
   createCombinedMarkdownBundle,
   createMarkdownBundle,
   createSafeFence,
   detectFenceLanguage,
   fileReadPlaceholder,
} from '../dist/CommitMasterBundle.js'
import {
   collectEligibleChanges,
   escapeDisplayedPath,
   escapeMarkdownHeadingPath,
   isDefaultIgnoredPath,
   isSensitivePath,
   resolveAbsoluteChangedPath,
} from '../dist/CommitMasterChangedFiles.js'
import {
   clipboardSuccessMessage,
   runClipboardCommand,
   runWorkspaceBundleCommand,
} from '../dist/CommitMasterClipboardCommands.js'
import {
   deleteSavedWorkspace,
   discoverWorkspaceRepositories,
   loadSavedWorkspace,
   readSavedWorkspaces,
   resolveExplicitRepositories,
   saveWorkspace,
} from '../dist/CommitMasterWorkspaces.js'
import { copyToClipboard } from '../dist/CommitMasterClipboard.js'
import { ensureGitRepository } from '../dist/CommitMasterBootstrap.js'
import { InterruptionController } from '../dist/CommitMasterInterruption.js'
import { confirmGitInitialization, parseConfirmationAnswer } from '../dist/CommitMasterPrompt.js'

const gitspanBinary = fileURLToPath(
   new URL('../dist/CommitMasterCommitspan.js', import.meta.url)
)
const gitautoBinary = fileURLToPath(
   new URL('../dist/CommitMasterAutocommit.js', import.meta.url)
)
const gitpathsBinary = fileURLToPath(new URL('../dist/CommitMasterGitpaths.js', import.meta.url))
const gitbundleBinary = fileURLToPath(new URL('../dist/CommitMasterGitbundle.js', import.meta.url))
const gitstashBinary = fileURLToPath(new URL('../dist/CommitMasterGitstash.js', import.meta.url))
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
   const repository = await realpath(await mkdtemp(join(tmpdir(), 'commit-master-test-')))
   temporaryPaths.add(repository)
   git(repository, ['init', '--quiet'])
   git(repository, ['config', 'user.name', 'Commit Master Test'])
   git(repository, ['config', 'user.email', 'commit-master@example.invalid'])
   git(repository, ['config', 'commit.gpgSign', 'false'])
   return repository
}

const createProject = async (): Promise<string> => {
   const project = await realpath(await mkdtemp(join(tmpdir(), 'commit-master-project-')))
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
   command: 'gitspan' | 'gitauto' | 'gitpaths' | 'gitbundle' | 'gitstash',
   args: readonly string[] = [],
   environment?: NodeJS.ProcessEnv
): CommandResult =>
   execute(
      process.execPath,
      [
         command === 'gitspan'
            ? gitspanBinary
            : command === 'gitauto'
              ? gitautoBinary
              : command === 'gitpaths'
                ? gitpathsBinary
                : command === 'gitbundle'
                  ? gitbundleBinary
                  : gitstashBinary,
         ...args,
      ],
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

const stashCount = (repository: string): number => {
   const entries = git(repository, ['stash', 'list', '--format=%H'])
   return entries ? entries.split('\n').length : 0
}

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

describe('package command names', () => {
   it('publishes canonical Git-prefixed commands while retaining silent compatibility aliases', async () => {
      const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
         bin: Record<string, string>
      }

      assert.equal(manifest.bin.gitauto, 'dist/CommitMasterAutocommit.js')
      assert.equal(manifest.bin.gitspan, 'dist/CommitMasterCommitspan.js')
      assert.equal(manifest.bin.gitpaths, 'dist/CommitMasterGitpaths.js')
      assert.equal(manifest.bin.gitbundle, 'dist/CommitMasterGitbundle.js')
      assert.equal(manifest.bin.gitstash, 'dist/CommitMasterGitstash.js')
      assert.equal(manifest.bin.autocommit, manifest.bin.gitauto)
      assert.equal(manifest.bin.commitspan, manifest.bin.gitspan)
   })
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

   it('initializes an unborn repository after confirmation and supports immediate gitauto', async () => {
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

      const result = runCli(project, 'gitauto')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(project), 1)
      assert.equal(git(project, ['status', '--porcelain']), '')
   })

   it('supports gitspan immediately after initializing an unborn repository', async () => {
      const project = await createProject()
      await writeRepositoryFile(project, 'src/first.ts', 'first\n')
      await writeRepositoryFile(project, 'src/second.ts', 'second\n')
      assert.equal(
         await ensureGitRepository(project, new InterruptionController(), async () => true),
         true
      )
      git(project, ['config', 'user.name', 'Commit Master Test'])
      git(project, ['config', 'user.email', 'commit-master@example.invalid'])

      const result = runCli(project, 'gitspan', ['10', '5'])
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

   it('refuses to initialize or wait in non-interactive runs for all five commands', async () => {
      for (const [command, args] of [
         ['gitauto', []],
         ['gitspan', ['10', '5']],
         ['gitpaths', []],
         ['gitbundle', []],
         ['gitstash', []],
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

describe('gitspan', () => {
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
      const result = runCli(repository, 'gitspan', ['10', '5'])
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
      assert.equal(runCli(repository, 'gitspan', ['10', '5']).status, 0)

      const clean = runCli(repository, 'gitspan', ['10', '5'])
      assert.equal(clean.status, 0, clean.stderr)
      assert.match(clean.stdout, /commit-master-test-/)
      assert.match(clean.stdout, /Nothing to commit\. The working tree is clean\./)
   })

   it('ignores a recent HEAD timestamp when distributing historical commits', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'baseline.ts': 'baseline\n' })
      const headTimestamp = Number(git(repository, ['show', '-s', '--format=%ct', 'HEAD']))
      for (let index = 0; index < 119; index += 1) {
         await writeRepositoryFile(
            repository,
            `src/change-${String(index).padStart(3, '0')}.ts`,
            `${index}\n`
         )
      }

      const before = Math.floor(Date.now() / 1000)
      const result = runCli(repository, 'gitspan', ['10', '5'])
      const after = Math.ceil(Date.now() / 1000)

      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(repository), 120)
      assert.match(result.stdout, /119 commits · 24 days · 5\/day/)
      assert.doesNotMatch(result.stderr, /HEAD timestamp|before HEAD/)

      const timestamps = git(repository, ['log', '--reverse', '--format=%at'])
         .split('\n')
         .map(Number)
      assert.equal(timestamps.length, 120)
      assert.equal(timestamps[0], headTimestamp)
      const created = timestamps.slice(1)
      assert.ok((created[0] ?? 0) < headTimestamp)
      for (let index = 1; index < created.length; index += 1) {
         assert.ok((created[index] ?? 0) > (created[index - 1] ?? 0))
      }
      assert.ok((created.at(-1) ?? 0) <= after)
      assert.ok((created.at(-1) ?? 0) >= before - 24 * 24 * 60 * 60)

      const dates = git(repository, [
         'log',
         '--reverse',
         '--format=%ad',
         '--date=format-local:%Y-%m-%d',
         'HEAD~119..HEAD',
      ]).split('\n')
      const perDay = new Map<string, number>()
      for (const date of dates) perDay.set(date, (perDay.get(date) ?? 0) + 1)
      assert.equal(perDay.size, 24)
      for (const count of perDay.values()) assert.ok(count <= 5)
   })

   it('keeps the requested duration when it already covers the required historical days', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'baseline.ts': 'baseline\n' })
      for (let index = 0; index < 119; index += 1) {
         await writeRepositoryFile(
            repository,
            `src/change-${String(index).padStart(3, '0')}.ts`,
            `${index}\n`
         )
      }

      const result = runCli(repository, 'gitspan', ['30', '5'])
      assert.equal(result.status, 0, result.stderr)
      assert.equal(commitCount(repository), 120)
      assert.match(result.stdout, /119 commits · 30 days · 5\/day/)

      const dates = git(repository, [
         'log',
         '--reverse',
         '--format=%ad',
         '--date=format-local:%Y-%m-%d',
         'HEAD~119..HEAD',
      ]).split('\n')
      const perDay = new Map<string, number>()
      for (const date of dates) perDay.set(date, (perDay.get(date) ?? 0) + 1)
      assert.equal(perDay.size, 24)
      for (const count of perDay.values()) assert.ok(count <= 5)
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

      const result = runCli(repository, 'gitauto')
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

describe('clipboard commands', () => {
   it('preserves the complete centralized generated-file and directory ignore policy', () => {
      for (const file of [
         'yarn.lock',
         'pnpm-lock.yaml',
         'bun.lockb',
         'Cargo.lock',
         'generated.ts',
         'mongoose.gen.ts',
         'resolvers.generated.ts',
         'typeDefs.generated.ts',
         'types.generated.ts',
         'schema.generated.ts',
         'client.generated.ts',
         'tsconfig.tsbuildinfo',
         'tsconfig.node.tsbuildinfo',
         '.DS_Store',
         'vite.config.ts.timestamp-12345',
      ]) {
         assert.equal(isDefaultIgnoredPath(`packages/api/src/${file}`), true, file)
      }

      for (const directory of [
         '_locales',
         'src-tauri/target',
         'gen',
         'temp',
         'ffmpeg',
         'migrations',
         'sql',
         'dist',
         '.xcode',
         'vendor/bundle',
         '.git',
         'Pods',
         '.nuxt',
         '.next',
         '.idea',
         '.bundle',
         'node_modules',
         'cache',
      ]) {
         assert.equal(isDefaultIgnoredPath(`packages/web/${directory}/nested/file.ts`), true, directory)
         assert.equal(
            isDefaultIgnoredPath(`PACKAGES/WEB/${directory.toUpperCase()}/NESTED/file.ts`),
            true,
            directory
         )
      }

      assert.equal(isDefaultIgnoredPath('packages/web/package.json'), false)
   })

   it('preserves every required ignored file extension case-insensitively', () => {
      const extensions = [
         '.log', '.sql', '.onnx', '.TAG', '.pdf', '.docx', '.csv', '.jpg', '.jpeg',
         '.png', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico', '.tif', '.tiff',
         '.heic', '.heif', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpeg',
         '.mpg', '.wmv', '.flv', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
         '.opus', '.wma', '.aiff', '.aif', '.zip', '.tar', '.gz', '.tgz', '.bz2',
         '.xz', '.7z', '.rar', '.db', '.sqlite', '.sqlite3', '.wasm', '.exe', '.dll',
         '.dylib', '.so',
      ]
      for (const extension of extensions) {
         assert.equal(isDefaultIgnoredPath(`src/FILE${extension}`), true, extension)
      }
   })

   it('collects a stable staged, unstaged, renamed, deleted, and untracked union', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, {
         'modified.ts': 'before\n',
         'deleted.ts': 'delete\n',
         'old-name.ts': 'rename\n',
      })
      await writeRepositoryFile(repository, 'modified.ts', 'after\n')
      await unlink(join(repository, 'deleted.ts'))
      await rename(join(repository, 'old-name.ts'), join(repository, 'new-name.ts'))
      await writeRepositoryFile(repository, 'package.json', '{"private":true}\n')
      await writeRepositoryFile(repository, 'docs/guide.md', 'Example: ```ts\ncode\n```\n')
      await writeRepositoryFile(repository, 'node_modules/ignored.js', 'ignored\n')
      await writeRepositoryFile(repository, 'yarn.lock', 'ignored\n')
      await writeFile(join(repository, 'unknown.bin'), Buffer.from([0, 1, 2, 3]))
      git(repository, ['add', '--', 'modified.ts', 'old-name.ts', 'new-name.ts'])

      const changes = await collectEligibleChanges(repository)
      assert.deepEqual(
         changes.map((change) => change.path),
         ['deleted.ts', 'docs/guide.md', 'modified.ts', 'new-name.ts', 'package.json', 'unknown.bin']
      )
      assert.equal(changes.find((change) => change.path === 'new-name.ts')?.kind, 'renamed')
      assert.equal(changes.find((change) => change.path === 'deleted.ts')?.kind, 'deleted')
      assert.equal(isDefaultIgnoredPath('package.json'), false)
      assert.equal(isDefaultIgnoredPath('src/generated.generated.ts'), true)
      assert.equal(isDefaultIgnoredPath('src-tauri/target/release/app'), true)
   })

   it('protects tracked environment, credential, and private-key contents', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'baseline.ts': 'baseline\n' })
      await writeRepositoryFile(repository, '.env', 'TOKEN=old\n')
      await writeRepositoryFile(repository, 'credentials.json', '{"token":"old"}\n')
      await writeRepositoryFile(repository, 'keys/private.pem', 'old-key\n')
      git(repository, ['add', '--force', '--', '.env', 'credentials.json', 'keys/private.pem'])
      git(repository, ['commit', '--quiet', '-m', 'Sensitive baseline'])
      await writeRepositoryFile(repository, '.env', 'TOKEN=super-secret\n')
      await writeRepositoryFile(repository, 'credentials.json', '{"token":"cloud-secret"}\n')
      await writeRepositoryFile(repository, 'keys/private.pem', 'private-key-material\n')

      const changes = await collectEligibleChanges(repository)
      assert.deepEqual(changes.map((change) => change.path), [
         '.env',
         'credentials.json',
         'keys/private.pem',
      ])
      const bundle = await createMarkdownBundle(repository, changes)
      assert.equal((bundle.match(/\[SENSITIVE FILE OMITTED\]/g) ?? []).length, 3)
      assert.doesNotMatch(bundle, /super-secret|cloud-secret|private-key-material/)
      assert.equal(isSensitivePath('.env.production'), true)
      assert.equal(isSensitivePath('config/service-account-production.json'), true)
      assert.equal(isSensitivePath('keys/id_ed25519'), true)
      for (const file of [
         '.env.local',
         '.env.production',
         'private.pem',
         'private.key',
         'certificate.p12',
         'certificate.pfx',
         'release.keystore',
         'id_rsa',
         'id_ed25519',
         'credentials.json',
         'service-account-staging.json',
         'secrets.json',
         '.npmrc',
         '.pypirc',
         '.netrc',
      ]) {
         assert.equal(isSensitivePath(`config/${file}`), true, file)
      }

      let paths = ''
      await runClipboardCommand('gitpaths', repository, undefined, async (content) => {
         paths = content
      })
      assert.match(paths, /\.env/)
      assert.doesNotMatch(paths, /super-secret/)
   })

   it('works immediately after shared Git initialization', async () => {
      const project = await createProject()
      await writeRepositoryFile(project, 'first.ts', 'first\n')
      assert.equal(
         await ensureGitRepository(project, new InterruptionController(), async () => true),
         true
      )
      let copied = ''
      await runClipboardCommand('gitpaths', project, undefined, async (content) => {
         copied = content
      })
      assert.equal(copied, resolveAbsoluteChangedPath(project, 'first.ts'))
   })

   it('builds language-aware, fence-safe Markdown with deletion and binary placeholders', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'docs/guide.md', 'Example: ```ts\ncode\n```\n')
      await writeRepositoryFile(repository, 'vite.config.d.ts', 'export type Config = string\n')
      await writeFile(join(repository, 'unknown.bin'), Buffer.from([0, 1, 2, 3]))
      const bundle = await createMarkdownBundle(repository, [
         { kind: 'deleted', path: 'src/OldFile.ts' },
         { kind: 'modified', path: 'docs/guide.md' },
         { kind: 'new', path: 'unknown.bin' },
         { kind: 'new', path: 'vite.config.d.ts' },
      ])

      assert.ok(bundle.startsWith(`Repository: ${repository}\n\n`))
      assert.match(bundle, /```text\n\[FILE DELETED\]\n```/)
      assert.match(bundle, /````markdown\nExample: ```ts/)
      assert.match(bundle, /```text\n\[BINARY FILE OMITTED\]\n```/)
      assert.match(bundle, /```ts\nexport type Config = string/)
      assert.ok(bundle.endsWith('------------------------------'))
      assert.equal(detectFenceLanguage('env.d.ts'), 'ts')
      assert.equal(detectFenceLanguage('file.unknown'), 'text')
      assert.equal(createSafeFence('contains ``` here'), '````')
      assert.equal(createSafeFence('contains `````````` here').length, 11)
   })

   it('builds one bounded Markdown document with clear repository boundaries', async () => {
      const app = await createRepository()
      const api = await createRepository()
      await writeRepositoryFile(app, 'src/App.vue', '<template />\n')
      await writeRepositoryFile(api, 'src/server.ts', 'export const ready = true\n')

      const bundle = await createCombinedMarkdownBundle([
         { root: app, name: 'erp-app', changes: [{ kind: 'new', path: 'src/App.vue' }] },
         { root: api, name: 'erp-api', changes: [{ kind: 'new', path: 'src/server.ts' }] },
      ])

      assert.match(bundle, /^# Repository Bundle\n\nRepositories: 2\nFiles: 2/m)
      assert.match(bundle, /## erp-app\n\nPath: .*\nChanged files: 1/)
      assert.match(bundle, /## erp-api\n\nPath: .*\nChanged files: 1/)
      assert.match(bundle, /```vue\n<template \/>/)
      assert.match(bundle, /```ts\nexport const ready/)
   })

   it('handles missing, unreadable, and oversized files without truncating content', async () => {
      const repository = await createRepository()
      await mkdir(join(repository, 'replaced-with-directory'))
      await writeRepositoryFile(repository, 'large.txt', '12345')
      const bundle = await createMarkdownBundle(
         repository,
         [
            { kind: 'modified', path: 'missing.txt' },
            { kind: 'modified', path: 'replaced-with-directory' },
            { kind: 'modified', path: 'large.txt' },
         ],
         { maxFileBytes: 4 }
      )

      assert.match(bundle, /\[FILE NOT FOUND\]/)
      assert.match(bundle, /\[FILE UNREADABLE\]/)
      assert.match(bundle, /\[FILE TOO LARGE\]/)
      assert.equal(fileReadPlaceholder(Object.assign(new Error('denied'), { code: 'EACCES' })), '[FILE UNREADABLE]')
   })

   it('stops before clipboard mutation when total bundle construction fails', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'large.txt', 'content\n')
      let clipboardCalled = false

      await assert.rejects(
         runClipboardCommand(
            'gitbundle',
            repository,
            undefined,
            async () => {
               clipboardCalled = true
            },
            (root, changes, options) =>
               createMarkdownBundle(root, changes, {
                  ...options,
                  maxBundleBytes: Math.min(40, MAX_BUNDLE_BYTES),
               })
         ),
         /bundle exceeds the 10 MiB safety limit/i
      )
      assert.equal(clipboardCalled, false)
   })

   it('escapes control and Markdown-sensitive path characters only for display', () => {
      assert.equal(escapeDisplayedPath('/repo/line\nbreak\t.ts'), '/repo/line\\nbreak\\t.ts')
      assert.equal(
         escapeMarkdownHeadingPath('/repo/a`b[1]#file.ts'),
         '/repo/a\\`b\\[1\\]\\#file.ts'
      )
   })

   it(
      'includes a symbolic-link target without following it outside the repository',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         const outside = join(await createProject(), 'outside-secret.txt')
         await writeFile(outside, 'must-not-be-read\n', 'utf8')
         await symlink(outside, join(repository, 'linked.txt'))

         const bundle = await createMarkdownBundle(repository, [
            { kind: 'new', path: 'linked.txt' },
         ])
         assert.match(bundle, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
         assert.doesNotMatch(bundle, /must-not-be-read/)
      }
   )

   it('falls back between clipboard providers and provides Linux installation guidance', async () => {
      const attempted: string[] = []
      await copyToClipboard('content', undefined, 'linux', async (program) => {
         attempted.push(program.command)
         return program.command === 'xclip'
      })
      assert.deepEqual(attempted, ['wl-copy', 'xclip'])

      await assert.rejects(
         copyToClipboard('content', undefined, 'linux', async () => false),
         /Unable to copy to the clipboard\.\nInstall wl-copy, xclip, or xsel\./
      )
      assert.equal(clipboardSuccessMessage('gitpaths', 8), '8 file paths copied.')
      assert.equal(
         clipboardSuccessMessage('gitbundle', 8),
         '8 changed files bundled and copied.'
      )
   })

   it(
      'uses clipboard-specific Ctrl+C output without reporting commits',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         const wrapperDirectory = await mkdtemp(join(tmpdir(), 'commit-master-clipboard-wrapper-'))
         temporaryPaths.add(wrapperDirectory)
         const provider = process.platform === 'darwin' ? 'pbcopy' : 'wl-copy'
         const wrapper = join(wrapperDirectory, provider)
         await writeFile(wrapper, '#!/bin/sh\nkill -INT "$PPID"\nexit 130\n', 'utf8')
         await chmod(wrapper, 0o755)

         const result = runCli(repository, 'gitpaths', [], {
            PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
         })
         assert.equal(result.status, 130)
         assert.match(result.stderr, /Copy cancelled\./)
         assert.match(result.stderr, /The clipboard was not updated\./)
         assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /commits|paths copied/i)
      }
   )

   it('resolves nested directories without collecting a sibling repository', async () => {
      const repository = await createRepository()
      const nested = join(repository, 'src', 'nested')
      await mkdir(nested, { recursive: true })
      await writeRepositoryFile(repository, 'root-change.ts', 'root\n')
      const sibling = await createRepository()
      await writeRepositoryFile(sibling, 'sibling-change.ts', 'sibling\n')
      let copied = ''

      await runClipboardCommand('gitpaths', nested, undefined, async (content) => {
         copied = content
      })
      assert.equal(copied, resolveAbsoluteChangedPath(repository, 'root-change.ts'))
      assert.doesNotMatch(copied, /sibling-change/)
   })

   it('copies absolute paths and does not invoke the clipboard for a clean tree', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'src/new file.ts', 'new\n')
      let copied = ''
      await runClipboardCommand('gitpaths', repository, undefined, async (content) => {
         copied = content
      })
      assert.equal(copied, resolveAbsoluteChangedPath(repository, 'src/new file.ts'))

      await createBaselineCommit(repository, { 'src/new file.ts': 'new\n' })
      let cleanClipboardCalled = false
      await runClipboardCommand('gitbundle', repository, undefined, async () => {
         cleanClipboardCalled = true
      })
      assert.equal(cleanClipboardCalled, false)
   })

   it('deduplicates explicit roots, discovers child repositories, and leaves the clipboard intact when clean', async () => {
      const workspace = await createProject()
      const app = join(workspace, 'erp-app')
      const api = join(workspace, 'erp-api')
      await mkdir(app)
      await mkdir(api)
      for (const repository of [app, api]) {
         git(repository, ['init', '--quiet'])
         git(repository, ['config', 'user.name', 'Commit Master Test'])
         git(repository, ['config', 'user.email', 'commit-master@example.invalid'])
      }
      await writeRepositoryFile(app, 'src/app.ts', 'app\n')

      assert.deepEqual(await resolveExplicitRepositories([app, join(app, 'src'), app]), [await realpath(app)])
      assert.deepEqual(
         await discoverWorkspaceRepositories(workspace),
         [await realpath(api), await realpath(app)].sort()
      )
      let copied = false
      await runWorkspaceBundleCommand([api], undefined, async () => {
         copied = true
      })
      assert.equal(copied, false)
   })

   it('persists and resolves named workspaces without storing file content', async () => {
      const configuration = await createProject()
      const repository = await createRepository()
      const configVariable = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME'
      const originalConfigHome = process.env[configVariable]
      process.env[configVariable] = configuration
      try {
         await saveWorkspace('erp', [repository])
         assert.deepEqual(await readSavedWorkspaces(), [{ name: 'erp', repositories: [repository] }])
         assert.deepEqual(await loadSavedWorkspace('erp'), [repository])
         await deleteSavedWorkspace('erp')
         assert.deepEqual(await readSavedWorkspaces(), [])
      } finally {
         if (originalConfigHome === undefined) delete process.env[configVariable]
         else process.env[configVariable] = originalConfigHome
      }
   })
})

describe('gitstash', () => {
   it('stashes staged, unstaged, deleted, renamed, and untracked changes while preserving ignored files and older stashes', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, {
         '.gitignore': 'ignored.txt\n',
         'modified.ts': 'before\n',
         'staged.ts': 'before\n',
         'deleted.ts': 'delete\n',
         'old-name.ts': 'rename\n',
      })
      await writeRepositoryFile(repository, 'previous.ts', 'previous\n')
      git(repository, ['stash', 'push', '--include-untracked', '--message', 'Previous stash'])

      await writeRepositoryFile(repository, 'modified.ts', 'after\n')
      await writeRepositoryFile(repository, 'staged.ts', 'staged after\n')
      git(repository, ['add', '--', 'staged.ts'])
      await unlink(join(repository, 'deleted.ts'))
      await rename(join(repository, 'old-name.ts'), join(repository, 'new-name.ts'))
      await writeRepositoryFile(repository, 'untracked.ts', 'untracked\n')
      await writeRepositoryFile(repository, 'ignored.txt', 'ignored\n')

      const result = runCli(repository, 'gitstash')

      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), 'Changes stashed successfully.')
      assert.equal(stashCount(repository), 2)
      assert.equal(git(repository, ['status', '--porcelain']), '')
      await access(join(repository, 'ignored.txt'))
      const stashMessages = git(repository, ['stash', 'list', '--format=%gs'])
      assert.match(stashMessages, /Commit Master stash/)
      assert.match(stashMessages, /Previous stash/)

      git(repository, ['stash', 'apply', '--index', 'stash@{0}'])
      assert.match(stagedPaths(repository), /staged\.ts/)
      const restored = git(repository, ['status', '--porcelain'])
      assert.match(restored, /modified\.ts/)
      assert.match(restored, /deleted\.ts/)
      assert.match(restored, /new-name\.ts/)
      assert.match(restored, /untracked\.ts/)
   })

   it('uses an exact custom Unicode title and rejects extra arguments', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'tracked.ts': 'before\n' })
      await writeRepositoryFile(repository, 'tracked.ts', 'after\n')
      const title = 'Before auth – $pecial! 日本語'

      const result = runCli(repository, 'gitstash', [title])
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), `Changes stashed successfully: ${title}`)
      assert.ok(git(repository, ['stash', 'list', '-1', '--format=%gs']).endsWith(title))

      await writeRepositoryFile(repository, 'another.ts', 'another\n')
      const invalid = runCli(repository, 'gitstash', ['one', 'two'])
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stderr, /Usage:\n  gitstash\n  gitstash "stash title"/)
      assert.equal(stashCount(repository), 1)
   })

   it('does not create an empty stash for a clean working tree', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'tracked.ts': 'clean\n' })

      const result = runCli(repository, 'gitstash')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), 'Nothing to stash. The working tree is clean.')
      assert.equal(stashCount(repository), 0)
   })

   it('stashes files immediately after shared initialization without leaving a branch commit', async () => {
      const project = await createProject()
      await writeRepositoryFile(project, 'first.ts', 'first\n')
      assert.equal(
         await ensureGitRepository(project, new InterruptionController(), async () => true),
         true
      )
      git(project, ['config', 'user.name', 'Commit Master Test'])
      git(project, ['config', 'user.email', 'commit-master@example.invalid'])

      const result = runCli(project, 'gitstash')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(stashCount(project), 1)
      assert.equal(git(project, ['status', '--porcelain']), '')
      assert.notEqual(execute('git', ['rev-parse', '--verify', 'HEAD'], project).status, 0)

      git(project, ['commit', '--allow-empty', '--quiet', '-m', 'Initial'])
      git(project, ['stash', 'apply', 'stash@{0}'])
      await access(join(project, 'first.ts'))
   })

   it('rejects unsafe operation state before creating a stash', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'tracked.ts': 'before\n' })
      await writeRepositoryFile(repository, 'tracked.ts', 'after\n')
      const gitDirectory = git(repository, ['rev-parse', '--absolute-git-dir'])
      await writeFile(join(gitDirectory, 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n')

      const result = runCli(repository, 'gitstash')
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Git merge operation is in progress/)
      await unlink(join(gitDirectory, 'MERGE_HEAD'))
      assert.equal(stashCount(repository), 0)
      assert.match(git(repository, ['status', '--porcelain']), /tracked\.ts/)
   })

   it('resolves a nested directory without affecting a sibling repository', async () => {
      const repository = await createRepository()
      await createBaselineCommit(repository, { 'root.ts': 'before\n' })
      await writeRepositoryFile(repository, 'root.ts', 'after\n')
      const nested = join(repository, 'src', 'nested')
      await mkdir(nested, { recursive: true })
      const sibling = await createRepository()
      await writeRepositoryFile(sibling, 'sibling.ts', 'sibling\n')

      const result = runCli(nested, 'gitstash')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(stashCount(repository), 1)
      assert.equal(stashCount(sibling), 0)
      assert.match(git(sibling, ['status', '--porcelain']), /sibling\.ts/)
   })

   it(
      'uses stash-specific Ctrl+C output when no stash was created',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         const wrapperDirectory = await mkdtemp(join(tmpdir(), 'commit-master-stash-wrapper-'))
         temporaryPaths.add(wrapperDirectory)
         const realGit = execute('sh', ['-c', 'command -v git'], repository).stdout.trim()
         const wrapper = join(wrapperDirectory, 'git')
         await writeFile(
            wrapper,
            '#!/bin/sh\nif [ "$1" = "stash" ]; then kill -INT "$PPID"; exit 130; fi\nexec "$REAL_GIT" "$@"\n',
            'utf8'
         )
         await chmod(wrapper, 0o755)

         const result = runCli(repository, 'gitstash', [], {
            PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
            REAL_GIT: realGit,
         })
         assert.equal(result.status, 130)
         assert.match(result.stderr, /Stash cancelled\./)
         assert.match(result.stderr, /Your changes were not removed\./)
         assert.doesNotMatch(result.stderr, /Created commits/)
         assert.equal(stashCount(repository), 0)
         assert.match(git(repository, ['status', '--porcelain']), /created\.ts/)
      }
   )

   it(
      'reports success when interruption arrives after the stash was created',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await createBaselineCommit(repository, { 'tracked.ts': 'before\n' })
         await writeRepositoryFile(repository, 'tracked.ts', 'after\n')
         const wrapperDirectory = await mkdtemp(join(tmpdir(), 'commit-master-stash-after-wrapper-'))
         temporaryPaths.add(wrapperDirectory)
         const realGit = execute('sh', ['-c', 'command -v git'], repository).stdout.trim()
         const wrapper = join(wrapperDirectory, 'git')
         await writeFile(
            wrapper,
            '#!/bin/sh\nif [ "$1" = "stash" ]; then "$REAL_GIT" "$@"; kill -INT "$PPID"; exit 130; fi\nexec "$REAL_GIT" "$@"\n',
            'utf8'
         )
         await chmod(wrapper, 0o755)

         const result = runCli(repository, 'gitstash', [], {
            PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
            REAL_GIT: realGit,
         })
         assert.equal(result.status, 0, result.stderr)
         assert.equal(result.stdout.trim(), 'Changes stashed successfully.')
         assert.equal(stashCount(repository), 1)
         assert.equal(git(repository, ['status', '--porcelain']), '')
      }
   )

   it(
      'preserves changes and existing stashes when Git rejects stash creation',
      { skip: process.platform === 'win32' },
      async () => {
         const repository = await createRepository()
         await createBaselineCommit(repository, { 'baseline.ts': 'baseline\n' })
         await writeRepositoryFile(repository, 'previous.ts', 'previous\n')
         git(repository, ['stash', 'push', '--include-untracked', '--message', 'Previous'])
         await writeRepositoryFile(repository, 'created.ts', 'created\n')
         const wrapperDirectory = await mkdtemp(join(tmpdir(), 'commit-master-stash-fail-wrapper-'))
         temporaryPaths.add(wrapperDirectory)
         const realGit = execute('sh', ['-c', 'command -v git'], repository).stdout.trim()
         const wrapper = join(wrapperDirectory, 'git')
         await writeFile(
            wrapper,
            '#!/bin/sh\nif [ "$1" = "stash" ]; then echo "stash rejected" >&2; exit 1; fi\nexec "$REAL_GIT" "$@"\n',
            'utf8'
         )
         await chmod(wrapper, 0o755)

         const result = runCli(repository, 'gitstash', [], {
            PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
            REAL_GIT: realGit,
         })
         assert.notEqual(result.status, 0)
         assert.match(result.stderr, /stash rejected/)
         assert.equal(stashCount(repository), 1)
         assert.match(git(repository, ['status', '--porcelain']), /created\.ts/)
      }
   )
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

      const result = runCli(repository, 'gitauto')

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

      const result = runCli(repository, 'gitauto')

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

         const result = runCli(repository, 'gitauto', [], {
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

      const result = runCli(repository, 'gitauto')

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

         const result = runCli(repository, 'gitauto', [], {
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

         const result = runCli(repository, 'gitauto')

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

         const result = runCli(repository, 'gitauto')

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

      const result = runCli(repository, 'gitauto')

      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout, /\u001b\[/)
      assert.equal((result.stdout.match(/commit-master-test-/g) ?? []).length, 0)
      assert.doesNotMatch(result.stdout, /Commit Master|Completed successfully|Created commits:/)
   })

   it('uses current author and committer timestamps for gitauto', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'created.ts', 'created\n')
      const before = Math.floor(Date.now() / 1000)

      const result = runCli(repository, 'gitauto')
      const after = Math.ceil(Date.now() / 1000)

      assert.equal(result.status, 0, result.stderr)
      const [author, committer] = git(repository, ['log', '-1', '--format=%at %ct'])
         .split(' ')
         .map(Number)
      assert.ok((author ?? 0) >= before && (author ?? 0) <= after)
      assert.ok((committer ?? 0) >= before && (committer ?? 0) <= after)
   })
})

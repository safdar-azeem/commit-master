import assert from 'node:assert/strict'
import {
   access,
   chmod,
   mkdir,
   mkdtemp,
   open,
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
   omittedBinaryContentPlaceholder,
} from '../dist/CommitMasterBundle.js'
import {
   collectEligibleChanges,
   detectExtractableDocumentType,
   escapeDisplayedPath,
   escapeMarkdownHeadingPath,
   isBundleExcludedPath,
   isDefaultIgnoredPath,
   isExtractableDocumentPath,
   isOmittedBinaryContentPath,
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
import { ClipboardInterruptedError } from '../dist/CommitMasterErrors.js'
import {
   MAX_DOCUMENT_SOURCE_BYTES,
   MAX_EXTRACTED_DOCUMENT_BYTES,
   extractDocumentContent,
} from '../dist/CommitMasterDocumentContent.js'
import {
   createMinimalDocx,
   createMinimalPdf,
   createMinimalPptx,
   createZipArchive,
} from './CommitMasterDocumentFixtures.js'

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

      assert.equal(isDefaultIgnoredPath('packages/web/migrations/001_init.sql'), false)
      assert.equal(isDefaultIgnoredPath('packages/web/sql/queries/users.sql'), false)
      assert.equal(isDefaultIgnoredPath('packages/web/package.json'), false)
   })

   it('preserves every required ignored file extension case-insensitively', () => {
      const fullyIgnoredExtensions = ['.log', '.TAG', '.csv']
      for (const extension of fullyIgnoredExtensions) {
         assert.equal(isDefaultIgnoredPath(`src/FILE${extension}`), true, extension)
         assert.equal(isBundleExcludedPath(`src/FILE${extension}`), true, extension)
         assert.equal(isOmittedBinaryContentPath(`src/FILE${extension}`), false, extension)
      }

      const omittedBinaryExtensions = [
         '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp',
         '.ico', '.tif', '.tiff', '.heic', '.heif', '.mp4', '.mov', '.avi', '.mkv',
         '.webm', '.m4v', '.mpeg', '.mpg', '.wmv', '.flv', '.mp3', '.wav', '.m4a',
         '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.onnx', '.zip',
         '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.db', '.sqlite',
         '.sqlite3', '.wasm', '.exe', '.dll', '.dylib', '.so',
      ]
      for (const extension of omittedBinaryExtensions) {
         assert.equal(isDefaultIgnoredPath(`src/FILE${extension}`), true, extension)
         assert.equal(isBundleExcludedPath(`src/FILE${extension}`), false, extension)
         assert.equal(isOmittedBinaryContentPath(`src/FILE${extension}`), true, extension)
         assert.equal(isExtractableDocumentPath(`src/FILE${extension}`), false, extension)
      }

      for (const documentPath of [
         'docs/spec.docx',
         'docs/SPEC.DOCX',
         'reports/review.pdf',
         'reports/REVIEW.PDF',
         'talks/roadmap.pptx',
         'talks/ROADMAP.PPTX',
      ]) {
         assert.equal(isDefaultIgnoredPath(documentPath), true, documentPath)
         assert.equal(isBundleExcludedPath(documentPath), false, documentPath)
         assert.equal(isOmittedBinaryContentPath(documentPath), false, documentPath)
         assert.equal(isExtractableDocumentPath(documentPath), true, documentPath)
      }
      assert.equal(detectExtractableDocumentType('docs/Spec.Docx'), 'docx')
      assert.equal(detectExtractableDocumentType('reports/Review.PDF'), 'pdf')
      assert.equal(detectExtractableDocumentType('talks/Roadmap.Pptx'), 'pptx')

      for (const svgPath of ['src/FILE.svg', 'src/FILE.SVG', 'public/logo.Svg']) {
         assert.equal(isDefaultIgnoredPath(svgPath), true, svgPath)
         assert.equal(isBundleExcludedPath(svgPath), false, svgPath)
         assert.equal(isOmittedBinaryContentPath(svgPath), false, svgPath)
      }

      assert.equal(isDefaultIgnoredPath('src/schema.SQL'), false)
      assert.equal(isDefaultIgnoredPath('src/schema.sql'), false)
      assert.equal(isBundleExcludedPath('node_modules/nested/hero.png'), true)
      assert.equal(isBundleExcludedPath('dist/assets/logo.svg'), true)
      assert.equal(isBundleExcludedPath('cache/model.onnx'), true)
      assert.equal(
         omittedBinaryContentPlaceholder('public/hero\n.png'),
         '[Binary file: hero\\n.png - content omitted]'
      )
      assert.equal(
         omittedBinaryContentPlaceholder('docs/spec\t.pdf'),
         '[Binary file: spec\\t.pdf - content omitted]'
      )
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
      assert.match(bundle, /```text\n\[Binary file: unknown\.bin - content omitted\]\n```/)
      assert.match(bundle, /```ts\nexport type Config = string/)
      assert.ok(bundle.endsWith('------------------------------'))
      assert.equal(detectFenceLanguage('env.d.ts'), 'ts')
      assert.equal(detectFenceLanguage('logo.svg'), 'svg')
      assert.equal(detectFenceLanguage('LOGO.SVG'), 'svg')
      assert.equal(detectFenceLanguage('file.unknown'), 'text')
      assert.equal(createSafeFence('contains ``` here'), '````')
      assert.equal(createSafeFence('contains `````````` here').length, 11)
   })

   it('keeps changed assets visible in gitbundle while omitting binary content', async () => {
      const repository = await createRepository()
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <circle cx="16" cy="16" r="16" fill="#0A0A0A"/>
</svg>
`
      await writeRepositoryFile(repository, 'src/App.vue', '<template />\n')
      await writeRepositoryFile(repository, 'public/logo.svg', svg)
      await writeRepositoryFile(repository, 'debug.log', 'noise\n')
      await mkdir(join(repository, 'assets'), { recursive: true })
      await mkdir(join(repository, 'docs'), { recursive: true })
      await mkdir(join(repository, 'models'), { recursive: true })
      await mkdir(join(repository, 'data'), { recursive: true })
      await mkdir(join(repository, 'node_modules/pkg'), { recursive: true })
      await writeFile(join(repository, 'public/hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
      await writeFile(join(repository, 'assets/photo.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0, 1]))
      await writeFile(join(repository, 'docs/spec.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1]))
      await writeFile(join(repository, 'docs/brief.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]))
      await writeFile(join(repository, 'models/detector.onnx'), Buffer.from([0x08, 0x01, 0x12, 0x00]))
      await writeFile(join(repository, 'public/codec.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
      await writeFile(join(repository, 'assets/brand.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]))
      await writeFile(join(repository, 'data/app.sqlite'), Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0, 1]))
      await writeFile(join(repository, 'large-hero.png'), Buffer.alloc(2 * 1024 * 1024, 1))
      await writeFile(join(repository, 'node_modules/pkg/hidden.png'), Buffer.from([1, 2, 3]))

      const pathChanges = await collectEligibleChanges(repository)
      assert.deepEqual(pathChanges.map((change) => change.path), ['src/App.vue'])

      const bundleChanges = await collectEligibleChanges(repository, 'bundle')
      assert.deepEqual(
         bundleChanges.map((change) => change.path),
         [
            'assets/brand.zip',
            'assets/photo.JPG',
            'data/app.sqlite',
            'docs/brief.docx',
            'docs/spec.pdf',
            'large-hero.png',
            'models/detector.onnx',
            'public/codec.wasm',
            'public/hero.png',
            'public/logo.svg',
            'src/App.vue',
         ]
      )

      const bundle = await createMarkdownBundle(repository, bundleChanges, { maxFileBytes: 1024 })
      assert.match(bundle, /### \[NEW\] src\/App\.vue/)
      assert.match(bundle, /```vue\n<template \/>/)
      assert.match(bundle, /### \[NEW\] public\/logo\.svg/)
      assert.match(bundle, /```svg\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      assert.match(bundle, /<circle cx="16" cy="16" r="16" fill="#0A0A0A"\/>/)
      assert.match(bundle, /### \[NEW\] public\/hero\.png/)
      assert.match(bundle, /```text\n\[Binary file: hero\.png - content omitted\]\n```/)
      assert.match(bundle, /### \[NEW\] assets\/photo\.JPG/)
      assert.match(bundle, /```text\n\[Binary file: photo\.JPG - content omitted\]\n```/)
      assert.match(bundle, /### \[NEW\] docs\/spec\.pdf/)
      assert.match(bundle, /```text\n\[PDF content could not be extracted\]\n```/)
      assert.match(bundle, /### \[NEW\] docs\/brief\.docx/)
      assert.match(bundle, /```text\n\[DOCX content could not be extracted\]\n```/)
      assert.match(bundle, /### \[NEW\] models\/detector\.onnx/)
      assert.match(bundle, /```text\n\[Binary file: detector\.onnx - content omitted\]\n```/)
      assert.match(bundle, /### \[NEW\] public\/codec\.wasm/)
      assert.match(bundle, /```text\n\[Binary file: codec\.wasm - content omitted\]\n```/)
      assert.match(bundle, /### \[NEW\] assets\/brand\.zip/)
      assert.match(bundle, /```text\n\[Binary file: brand\.zip - content omitted\]\n```/)
      assert.match(bundle, /### \[NEW\] data\/app\.sqlite/)
      assert.match(bundle, /```text\n\[Binary file: app\.sqlite - content omitted\]\n```/)
      assert.match(bundle, /### \[NEW\] large-hero\.png/)
      assert.match(bundle, /```text\n\[Binary file: large-hero\.png - content omitted\]\n```/)
      assert.doesNotMatch(bundle, /FILE TOO LARGE/)
      assert.doesNotMatch(bundle, /node_modules|debug\.log/)
      assert.doesNotMatch(bundle, /\u0089PNG|%PDF/)

      let pathsCopied = ''
      await runClipboardCommand('gitpaths', repository, undefined, async (content) => {
         pathsCopied = content
      })
      assert.match(pathsCopied, /src\/App\.vue/)
      assert.doesNotMatch(
         pathsCopied,
         /hero\.png|logo\.svg|photo\.JPG|spec\.pdf|brief\.docx|detector\.onnx|codec\.wasm|brand\.zip|app\.sqlite/
      )

      let bundled = ''
      await runClipboardCommand('gitbundle', repository, undefined, async (content) => {
         bundled = content
      })
      assert.match(bundled, /### \[NEW\] public\/hero\.png/)
      assert.match(bundled, /```svg\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      assert.match(bundled, /\[PDF content could not be extracted\]/)
      assert.match(bundled, /\[Binary file: detector\.onnx - content omitted\]/)
      assert.match(bundled, /\[Binary file: codec\.wasm - content omitted\]/)
   })

   it('preserves deletion, rename, and sensitive handling for bundled assets', async () => {
      const repository = await createRepository()
      await writeRepositoryFile(repository, 'icon.svg', '<svg></svg>\n')
      await writeFile(join(repository, 'hero-v2.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

      const bundle = await createMarkdownBundle(repository, [
         { kind: 'deleted', path: 'old.png' },
         {
            kind: 'renamed',
            path: 'hero-v2.png',
            previousPath: 'hero.png',
            isContentUnchanged: true,
         },
         { kind: 'renamed', path: 'icon.svg', previousPath: 'logo.svg' },
         { kind: 'new', path: '.env' },
      ])

      assert.match(bundle, /### \[DELETED\] old\.png/)
      assert.match(bundle, /```text\n\[FILE DELETED\]\n```/)
      assert.match(bundle, /### \[RENAMED\] hero\.png -> hero-v2\.png/)
      assert.match(bundle, /```text\n\[NO CHANGES IN FILE - RENAMED ONLY\]\n```/)
      assert.match(bundle, /### \[RENAMED\] logo\.svg -> icon\.svg/)
      assert.match(bundle, /```svg\n<svg><\/svg>/)
      assert.match(bundle, /```text\n\[SENSITIVE FILE OMITTED\]\n```/)
      assert.doesNotMatch(bundle, /Binary file: old\.png/)
   })

   it('extracts readable DOCX, PDF, and PPTX text for gitbundle review', async () => {
      const repository = await createRepository()
      await mkdir(join(repository, 'docs'), { recursive: true })
      await mkdir(join(repository, 'reports'), { recursive: true })
      await mkdir(join(repository, 'talks'), { recursive: true })
      await writeFile(
         join(repository, 'docs/product-spec.docx'),
         createMinimalDocx(
            ['Product Specification', 'Users authenticate using a session token.'],
            {},
            {
               header: 'Confidential specification',
               footer: 'Copyright Acme',
               footnotes: ['Primary endpoint analysis excludes protocol deviations.'],
               endnotes: ['See protocol appendix B for exclusion criteria.'],
               bodyBlocks: [
                  { type: 'paragraph', text: 'Product Specification' },
                  { type: 'paragraph', text: 'Users authenticate using a session token.' },
                  {
                     type: 'paragraph',
                     text: 'NS, not significant (P ≥ 0.05; t test, as stated in the figure).',
                  },
                  { type: 'image', fileName: 'figure6.png' },
                  {
                     type: 'paragraph',
                     text: 'Figure 6. Thirty-day healing outcomes with Nr-CWS and a silver-based dressing',
                  },
               ],
            }
         )
      )
      await writeFile(
         join(repository, 'docs/case-word.DOCX'),
         createMinimalDocx(['Case Insensitive Word'])
      )
      await writeFile(
         join(repository, 'reports/security-review.pdf'),
         createMinimalPdf(['Security Review', 'Authentication Architecture'])
      )
      await writeFile(join(repository, 'reports/case-review.PDF'), createMinimalPdf(['Uppercase PDF']))
      await writeFile(
         join(repository, 'talks/product-roadmap.pptx'),
         createMinimalPptx([
            {
               title: '2027 Product Roadmap',
               body: 'Platform modernization',
               notes: 'Keep this confidential.',
               imageFileName: 'roadmap.png',
            },
            { title: 'Goals', body: 'Reduce infrastructure cost', chart: true },
         ])
      )
      await writeFile(
         join(repository, 'talks/case-deck.PPTX'),
         createMinimalPptx([{ title: 'Uppercase Deck', body: 'One slide' }])
      )
      await writeFile(
         join(repository, 'docs/large-spec.docx'),
         createMinimalDocx(['Large source document'], {
            'word/padding.bin': Buffer.alloc(2 * 1024 * 1024, 1),
         })
      )
      await writeFile(join(repository, 'docs/broken.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]))
      await writeFile(join(repository, 'docs/broken.pdf'), Buffer.from('%PDF-not-valid'))
      await writeFile(join(repository, 'docs/broken.pptx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]))
      await writeFile(join(repository, 'reports/scanned.pdf'), createMinimalPdf(['']))
      await writeFile(join(repository, 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      await writeRepositoryFile(repository, 'public/logo.svg', '<svg id="mark"></svg>\n')
      await writeRepositoryFile(repository, 'src/App.vue', '<template />\n')

      const pathChanges = await collectEligibleChanges(repository)
      assert.deepEqual(pathChanges.map((change) => change.path), ['src/App.vue'])

      const bundleChanges = await collectEligibleChanges(repository, 'bundle')
      assert.ok(bundleChanges.some((change) => change.path === 'docs/product-spec.docx'))
      assert.ok(bundleChanges.some((change) => change.path === 'reports/security-review.pdf'))
      assert.ok(bundleChanges.some((change) => change.path === 'talks/product-roadmap.pptx'))
      assert.equal(bundleChanges.length, 14)

      const bundle = await createMarkdownBundle(repository, bundleChanges, { maxFileBytes: 64 })
      assert.match(bundle, /### \[NEW\] docs\/product-spec\.docx/)
      assert.match(bundle, /\[Extracted DOCX content\]/)
      assert.match(bundle, /Document Header:/)
      assert.match(bundle, /Confidential specification/)
      assert.match(bundle, /Document Body:/)
      assert.match(bundle, /Product Specification/)
      assert.match(bundle, /Users authenticate using a session token\./)
      assert.match(bundle, /Document Footer:/)
      assert.match(bundle, /Copyright Acme/)
      assert.match(bundle, /Document Notes:/)
      assert.match(bundle, /The treatment demonstrated improved healing\./)
      assert.match(bundle, /1\. Primary endpoint analysis excludes protocol deviations\./)
      assert.match(bundle, /Study limitations are documented separately\./)
      assert.match(bundle, /2\. See protocol appendix B for exclusion criteria\./)
      assert.match(
         bundle,
         /NS, not significant \(P ≥ 0\.05; t test, as stated in the figure\)\.\n\n\[Embedded image omitted: figure6\.png\]\n\nFigure 6\. Thirty-day healing outcomes with Nr-CWS and a silver-based dressing/
      )
      assert.doesNotMatch(bundle, /iVBORw0KGgo|word\/media|rIdImg|data:image/)
      assert.match(bundle, /### \[NEW\] docs\/case-word\.DOCX/)
      assert.match(bundle, /Case Insensitive Word/)
      assert.match(bundle, /### \[NEW\] reports\/security-review\.pdf/)
      assert.match(bundle, /\[Extracted PDF content: 2 pages\]/)
      assert.match(bundle, /--- Page 1 ---/)
      assert.match(bundle, /Security Review/)
      assert.match(bundle, /--- Page 2 ---/)
      assert.match(bundle, /Authentication Architecture/)
      assert.match(bundle, /### \[NEW\] reports\/case-review\.PDF/)
      assert.match(bundle, /Uppercase PDF/)
      assert.match(bundle, /### \[NEW\] talks\/product-roadmap\.pptx/)
      assert.match(bundle, /\[Extracted PPTX content: 2 slides\]/)
      assert.match(bundle, /--- Slide 1 ---/)
      assert.match(bundle, /2027 Product Roadmap/)
      assert.match(bundle, /Platform modernization/)
      assert.match(bundle, /\[Embedded image omitted: roadmap\.png\]/)
      assert.match(bundle, /Speaker Notes:/)
      assert.match(bundle, /Keep this confidential\./)
      assert.match(bundle, /--- Slide 2 ---/)
      assert.match(bundle, /\[Embedded chart omitted\]/)
      assert.match(bundle, /Reduce infrastructure cost/)
      assert.match(bundle, /### \[NEW\] talks\/case-deck\.PPTX/)
      assert.match(bundle, /Uppercase Deck/)
      assert.match(bundle, /### \[NEW\] docs\/large-spec\.docx/)
      assert.match(bundle, /Large source document/)
      assert.doesNotMatch(bundle, /FILE TOO LARGE/)
      assert.match(bundle, /\[DOCX content could not be extracted\]/)
      assert.match(bundle, /\[PDF content could not be extracted\]/)
      assert.match(bundle, /\[PPTX content could not be extracted\]/)
      assert.match(bundle, /\[PDF contains no extractable text - OCR not enabled\]/)
      assert.match(bundle, /```text\n\[Binary file: hero\.png - content omitted\]\n```/)
      assert.match(bundle, /```svg\n<svg id="mark"><\/svg>/)
      assert.doesNotMatch(bundle, /word\/document\.xml|ppt\/slides/)

      let pathsCopied = ''
      await runClipboardCommand('gitpaths', repository, undefined, async (content) => {
         pathsCopied = content
      })
      assert.match(pathsCopied, /src\/App\.vue/)
      assert.doesNotMatch(pathsCopied, /product-spec\.docx|security-review\.pdf|product-roadmap\.pptx|hero\.png|logo\.svg/)

      const missingBundle = await createMarkdownBundle(repository, [
         { kind: 'modified', path: 'missing.pdf' },
         { kind: 'modified', path: 'docs/product-spec.docx' },
         { kind: 'new', path: '.env' },
      ])
      assert.match(missingBundle, /\[FILE NOT FOUND\]/)
      assert.match(missingBundle, /\[Extracted DOCX content\]/)
      assert.match(missingBundle, /Users authenticate using a session token\./)
      assert.match(missingBundle, /\[SENSITIVE FILE OMITTED\]/)
      assert.doesNotMatch(missingBundle, /super-secret/)
   })

   it('builds one bounded Markdown document with clear repository boundaries', async () => {
      const app = await createRepository()
      const api = await createRepository()
      await writeRepositoryFile(app, 'src/App.vue', '<template />\n')
      await writeRepositoryFile(app, 'public/mark.svg', '<svg id="mark"></svg>\n')
      await writeFile(join(app, 'public/hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      await writeRepositoryFile(api, 'src/server.ts', 'export const ready = true\n')
      await mkdir(join(api, 'docs'), { recursive: true })
      await writeFile(join(api, 'docs/spec.pdf'), createMinimalPdf(['API specification']))
      await writeFile(join(api, 'docs/brief.docx'), createMinimalDocx(['Service brief']))

      const bundle = await createCombinedMarkdownBundle([
         {
            root: app,
            name: 'erp-app',
            changes: [
               { kind: 'new', path: 'src/App.vue' },
               { kind: 'new', path: 'public/mark.svg' },
               { kind: 'new', path: 'public/hero.png' },
            ],
         },
         {
            root: api,
            name: 'erp-api',
            changes: [
               { kind: 'new', path: 'src/server.ts' },
               { kind: 'new', path: 'docs/spec.pdf' },
               { kind: 'new', path: 'docs/brief.docx' },
            ],
         },
      ])

      assert.match(bundle, /^# Repository Bundle\n\nRepositories: 2\nFiles: 6/m)
      assert.match(bundle, /## erp-app\n\nPath: .*\nChanged files: 3/)
      assert.match(bundle, /## erp-api\n\nPath: .*\nChanged files: 3/)
      assert.match(bundle, /```vue\n<template \/>/)
      assert.match(bundle, /```svg\n<svg id="mark"><\/svg>/)
      assert.match(bundle, /\[Binary file: hero\.png - content omitted\]/)
      assert.match(bundle, /```ts\nexport const ready/)
      assert.match(bundle, /\[Extracted PDF content: 1 page\]/)
      assert.match(bundle, /API specification/)
      assert.match(bundle, /\[Extracted DOCX content\]/)
      assert.match(bundle, /Service brief/)
   })

   it('handles missing, unreadable, and oversized files without truncating content', async () => {
      const repository = await createRepository()
      await mkdir(join(repository, 'replaced-with-directory'))
      await mkdir(join(repository, 'report.pdf'))
      await writeRepositoryFile(repository, 'large.txt', '12345')
      await writeRepositoryFile(repository, 'large.svg', '<svg>12345</svg>\n')
      const bundle = await createMarkdownBundle(
         repository,
         [
            { kind: 'modified', path: 'missing.txt' },
            { kind: 'modified', path: 'replaced-with-directory' },
            { kind: 'modified', path: 'large.txt' },
            { kind: 'modified', path: 'large.svg' },
            { kind: 'modified', path: 'missing.png' },
            { kind: 'modified', path: 'missing.docx' },
            { kind: 'modified', path: 'report.pdf' },
         ],
         { maxFileBytes: 4 }
      )

      assert.match(bundle, /\[FILE NOT FOUND\]/)
      assert.match(bundle, /\[FILE UNREADABLE\]/)
      assert.equal((bundle.match(/\[FILE TOO LARGE\]/g) ?? []).length, 2)
      assert.match(bundle, /### \[MODIFIED\] missing\.png/)
      assert.match(bundle, /### \[MODIFIED\] missing\.docx/)
      assert.match(bundle, /### \[MODIFIED\] report\.pdf/)
      assert.match(bundle, /```text\n\[FILE NOT FOUND\]\n```/)
      assert.match(bundle, /```text\n\[FILE UNREADABLE\]\n```/)
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

   it('stops clipboard mutation when extracted document text exceeds the bundle limit or the request is cancelled', async () => {
      const repository = await createRepository()
      await writeFile(
         join(repository, 'notes.docx'),
         createMinimalDocx(['Document review content that is long enough to exceed a tiny bundle cap.'])
      )
      let oversizedClipboardCalled = false
      await assert.rejects(
         runClipboardCommand(
            'gitbundle',
            repository,
            undefined,
            async () => {
               oversizedClipboardCalled = true
            },
            (root, changes, options) =>
               createMarkdownBundle(root, changes, {
                  ...options,
                  maxBundleBytes: Math.min(80, MAX_BUNDLE_BYTES),
               })
         ),
         /bundle exceeds the 10 MiB safety limit/i
      )
      assert.equal(oversizedClipboardCalled, false)

      const controller = new AbortController()
      controller.abort()
      let cancelledClipboardCalled = false
      await assert.rejects(
         runClipboardCommand('gitbundle', repository, controller.signal, async () => {
            cancelledClipboardCalled = true
         }),
         ClipboardInterruptedError
      )
      assert.equal(cancelledClipboardCalled, false)
   })

   it('enforces document source and extracted-text safety limits without following document symlinks', async () => {
      const repository = await createRepository()
      const hugePath = join(repository, 'huge.pdf')
      const huge = await open(hugePath, 'w')
      await huge.truncate(MAX_DOCUMENT_SOURCE_BYTES + 1)
      await huge.close()
      const oversizedBundle = await createMarkdownBundle(repository, [
         { kind: 'new', path: 'huge.pdf' },
      ])
      assert.match(oversizedBundle, /\[PDF source exceeds the 32 MiB extraction limit\]/)
      assert.doesNotMatch(oversizedBundle, /could not be extracted|FILE TOO LARGE|Extracted PDF content/)

      const truncated = await extractDocumentContent(createMinimalDocx(['placeholder']), 'docx', {
         maxExtractedBytes: 64,
         parseOffice: async () => ({
            content: [{ type: 'paragraph', text: `Start ${'é'.repeat(400)} end` }],
         }),
      })
      assert.equal(truncated.kind, 'content')
      assert.match(truncated.content, /\[Extracted content truncated\]/)
      assert.doesNotMatch(truncated.content, /\uFFFD/)
      assert.equal(Buffer.from(truncated.content, 'utf8').toString('utf8'), truncated.content)
      assert.ok(Buffer.byteLength(truncated.content) <= 64)
      assert.ok(MAX_EXTRACTED_DOCUMENT_BYTES > 64)

      const controller = new AbortController()
      const parsing = extractDocumentContent(createMinimalDocx(['review']), 'pdf', {
         signal: controller.signal,
         parseOffice: async (_source, config) => {
            const signal = config?.abortSignal as AbortSignal | undefined
            return await new Promise<never>((_, reject) => {
               const fail = (): void => {
                  const error = new Error('Aborted')
                  error.name = 'AbortError'
                  reject(error)
               }
               if (signal?.aborted) fail()
               else signal?.addEventListener('abort', fail, { once: true })
            })
         },
      })
      controller.abort()
      await assert.rejects(parsing, (error: unknown) => error instanceof ClipboardInterruptedError)

      const headerFooter = await extractDocumentContent(createMinimalDocx(['Body copy']), 'docx', {
         parseOffice: async () => ({
            content: [{ type: 'paragraph', text: 'Body copy' }],
            auxiliary: {
               headers: [
                  { type: 'paragraph', text: 'Confidential specification' },
                  { type: 'paragraph', text: 'Confidential specification' },
               ],
               footers: [{ type: 'paragraph', text: 'Copyright Acme' }],
            },
         }),
      })
      assert.equal(headerFooter.kind, 'content')
      assert.match(headerFooter.content, /Document Header:\n\nConfidential specification/)
      assert.equal(
         (headerFooter.content.match(/Confidential specification/g) ?? []).length,
         1
      )
      assert.match(headerFooter.content, /Document Body:\n\nBody copy/)
      assert.match(headerFooter.content, /Document Footer:\n\nCopyright Acme/)

      const parsedNotes = await extractDocumentContent(
         createMinimalDocx(
            ['Body copy'],
            {},
            {
               footnotes: ['Primary endpoint analysis excludes protocol deviations.'],
               endnotes: ['See protocol appendix B for exclusion criteria.'],
            }
         ),
         'docx'
      )
      assert.equal(parsedNotes.kind, 'content')
      assert.match(parsedNotes.content, /Document Body:\n\nBody copy/)
      assert.match(parsedNotes.content, /The treatment demonstrated improved healing\./)
      assert.match(parsedNotes.content, /Document Notes:\n\n1\. Primary endpoint analysis excludes protocol deviations\.\n\n2\. See protocol appendix B for exclusion criteria\./)
      assert.doesNotMatch(parsedNotes.content, /Speaker Notes:/)
      assert.equal(
         (parsedNotes.content.match(/Primary endpoint analysis excludes protocol deviations\./g) ?? []).length,
         1
      )

      const formattedNotes = await extractDocumentContent(Buffer.from('docx'), 'docx', {
         parseOffice: async () => ({
            content: [
               {
                  type: 'paragraph',
                  text: 'The treatment demonstrated improved healing.',
                  children: [
                     {
                        type: 'text',
                        text: 'The treatment demonstrated improved healing.',
                        notes: [
                           {
                              type: 'note',
                              text: 'Primary endpoint analysis excludes protocol deviations.',
                              metadata: { noteType: 'footnote', noteId: '1' },
                           },
                           {
                              type: 'note',
                              text: 'Primary endpoint analysis excludes protocol deviations.',
                              metadata: { noteType: 'footnote', noteId: '1' },
                           },
                        ],
                     },
                  ],
               },
               {
                  type: 'paragraph',
                  text: 'Study limitations are documented separately.',
                  notes: [
                     {
                        type: 'note',
                        text: 'See protocol appendix B for exclusion criteria.',
                        children: [
                           {
                              type: 'paragraph',
                              text: 'See protocol appendix B for exclusion criteria.',
                           },
                        ],
                        metadata: { noteType: 'endnote', noteId: '1' },
                     },
                  ],
               },
               {
                  type: 'paragraph',
                  text: 'Already in the body.',
                  notes: [{ type: 'note', text: 'Already in the body.' }],
               },
            ],
         }),
      })
      assert.equal(formattedNotes.kind, 'content')
      assert.match(
         formattedNotes.content,
         /Document Notes:\n\n1\. Primary endpoint analysis excludes protocol deviations\.\n\n2\. See protocol appendix B for exclusion criteria\./
      )
      assert.doesNotMatch(formattedNotes.content, /3\. /)
      assert.equal((formattedNotes.content.match(/Already in the body\./g) ?? []).length, 1)

      const pptxSpeakerNotes = await extractDocumentContent(Buffer.from('pptx'), 'pptx', {
         parseOffice: async () => ({
            content: [
               {
                  type: 'slide',
                  children: [{ type: 'paragraph', text: 'Slide body' }],
                  notes: [{ type: 'note', text: 'Keep this confidential.' }],
               },
            ],
         }),
      })
      assert.equal(pptxSpeakerNotes.kind, 'content')
      assert.match(pptxSpeakerNotes.content, /Speaker Notes:\n\nKeep this confidential\./)
      assert.doesNotMatch(pptxSpeakerNotes.content, /Document Notes:/)

      const visualOrder = await extractDocumentContent(Buffer.from('docx'), 'docx', {
         parseOffice: async () => ({
            content: [
               { type: 'paragraph', text: 'NS, not significant (P ≥ 0.05; t test, as stated in the figure).' },
               {
                  type: 'image',
                  metadata: { attachmentName: 'word/media/figure6.png' },
                  children: [{ type: 'image', metadata: { attachmentName: 'figure6.png' } }],
               },
               {
                  type: 'paragraph',
                  text: 'Figure 6. Thirty-day healing outcomes with Nr-CWS and a silver-based dressing',
               },
               { type: 'image' },
               { type: 'image' },
               { type: 'chart', metadata: { title: 'Healing outcomes', attachmentName: 'chart1.xml' } },
               { type: 'embed', metadata: { name: 'graphicFrame' } },
               {
                  type: 'table',
                  children: [
                     {
                        type: 'row',
                        children: [
                           {
                              type: 'cell',
                              children: [
                                 { type: 'paragraph', text: 'Day 0' },
                                 { type: 'image', metadata: { attachmentName: 'day0.png' } },
                              ],
                           },
                           { type: 'cell', children: [{ type: 'paragraph', text: 'Day 15' }] },
                        ],
                     },
                  ],
               },
            ],
         }),
      })
      assert.equal(visualOrder.kind, 'content')
      assert.match(
         visualOrder.content,
         /NS, not significant \(P ≥ 0\.05; t test, as stated in the figure\)\.\n\n\[Embedded image omitted: figure6\.png\]\n\nFigure 6\. Thirty-day healing outcomes with Nr-CWS and a silver-based dressing/
      )
      assert.equal((visualOrder.content.match(/\[Embedded image omitted: figure6\.png\]/g) ?? []).length, 1)
      assert.match(
         visualOrder.content,
         /\[Embedded image omitted\]\n\n\[Embedded image omitted\]\n\n\[Embedded chart omitted: Healing outcomes\]\n\n\[Embedded visual content omitted\]/
      )
      assert.match(visualOrder.content, /Day 0 \[Embedded image omitted: day0\.png\] \| Day 15/)
      assert.doesNotMatch(visualOrder.content, /word\/media|chart1\.xml|graphicFrame|rId|iVBORw0KGgo|data:image/)

      const pptxVisuals = await extractDocumentContent(Buffer.from('pptx'), 'pptx', {
         parseOffice: async () => ({
            content: [
               {
                  type: 'slide',
                  children: [
                     { type: 'paragraph', text: '2027 Product Roadmap' },
                     { type: 'image', metadata: { attachmentName: 'roadmap.png' } },
                     { type: 'paragraph', text: 'Platform modernization' },
                  ],
                  notes: [{ type: 'note', text: 'Discuss infrastructure migration.' }],
               },
               {
                  type: 'slide',
                  children: [
                     { type: 'paragraph', text: 'Cost Reduction' },
                     { type: 'chart' },
                     { type: 'paragraph', text: 'Reduce infrastructure cost by 20%.' },
                  ],
               },
            ],
         }),
      })
      assert.equal(pptxVisuals.kind, 'content')
      assert.match(
         pptxVisuals.content,
         /--- Slide 1 ---\n\n2027 Product Roadmap\n\n\[Embedded image omitted: roadmap\.png\]\n\nPlatform modernization\n\nSpeaker Notes:\n\nDiscuss infrastructure migration\./
      )
      assert.match(
         pptxVisuals.content,
         /--- Slide 2 ---\n\nCost Reduction\n\n\[Embedded chart omitted\]\n\nReduce infrastructure cost by 20%\./
      )

      const pdfVisual = await extractDocumentContent(Buffer.from('pdf'), 'pdf', {
         parseOffice: async () => ({
            content: [
               {
                  type: 'page',
                  children: [
                     { type: 'paragraph', text: 'Clinical outcomes' },
                     { type: 'image', metadata: { attachmentName: 'wound.png' } },
                     { type: 'paragraph', text: 'Figure 1. Representative wound appearance.' },
                  ],
               },
            ],
         }),
      })
      assert.equal(pdfVisual.kind, 'content')
      assert.match(
         pdfVisual.content,
         /Clinical outcomes\n\n\[Embedded image omitted: wound\.png\]\n\nFigure 1\. Representative wound appearance\./
      )

      const parsedVisualDocx = await extractDocumentContent(
         createMinimalDocx([], {}, {
            bodyBlocks: [
               { type: 'paragraph', text: 'Before the figure' },
               { type: 'image', fileName: 'figure6.png' },
               { type: 'paragraph', text: 'Figure 6. Thirty-day healing outcomes' },
               { type: 'image', fileName: 'figure7.png' },
               { type: 'chart' },
               {
                  type: 'table',
                  rows: [[{ text: 'Day 0', imageFileName: 'day0.png' }, { text: 'Day 15' }]],
               },
            ],
         }),
         'docx'
      )
      assert.equal(parsedVisualDocx.kind, 'content')
      assert.match(
         parsedVisualDocx.content,
         /Before the figure\n\n\[Embedded image omitted: figure6\.png\]\n\nFigure 6\. Thirty-day healing outcomes\n\n\[Embedded image omitted: figure7\.png\]/
      )
      assert.match(parsedVisualDocx.content, /\[Embedded chart omitted\]/)
      assert.match(parsedVisualDocx.content, /Day 0 \[Embedded image omitted: day0\.png\] \| Day 15/)
      assert.doesNotMatch(parsedVisualDocx.content, /iVBORw0KGgo|word\/media|data:image|rIdImg/)

      const parsedVisualPptx = await extractDocumentContent(
         createMinimalPptx([
            {
               title: '2027 Product Roadmap',
               body: 'Platform modernization',
               notes: 'Discuss infrastructure migration.',
               imageFileName: 'roadmap.png',
            },
            { title: 'Cost Reduction', body: 'Reduce infrastructure cost by 20%.', chart: true },
         ]),
         'pptx'
      )
      assert.equal(parsedVisualPptx.kind, 'content')
      assert.match(parsedVisualPptx.content, /\[Embedded image omitted: roadmap\.png\]/)
      assert.match(parsedVisualPptx.content, /Speaker Notes:\n\nDiscuss infrastructure migration\./)
      assert.match(parsedVisualPptx.content, /\[Embedded chart omitted\]/)
      assert.doesNotMatch(parsedVisualPptx.content, /iVBORw0KGgo|ppt\/media|data:image/)
   })

   it('merges missing DOCX visuals through a bounded ZIP fallback without duplicating parser nodes', async () => {
      const headerAndBody = createMinimalDocx([], {}, {
         header: 'Hospital letterhead',
         headerImageFileName: 'logo.png',
         bodyBlocks: [
            { type: 'paragraph', text: 'Before the figure' },
            { type: 'image', fileName: 'figure6.png' },
            { type: 'paragraph', text: 'Figure 6. Thirty-day healing outcomes' },
         ],
      })
      const headerPresentBodyMissing = await extractDocumentContent(headerAndBody, 'docx', {
         parseOffice: async () => ({
            content: [
               { type: 'paragraph', text: 'Before the figure' },
               { type: 'paragraph', text: 'Figure 6. Thirty-day healing outcomes' },
            ],
            auxiliary: {
               headers: [{ type: 'image', metadata: { attachmentName: 'logo.png' } }],
            },
         }),
      })
      assert.equal(headerPresentBodyMissing.kind, 'content')
      assert.match(headerPresentBodyMissing.content, /\[Embedded image omitted: logo\.png\]/)
      assert.equal(
         (headerPresentBodyMissing.content.match(/\[Embedded image omitted: logo\.png\]/g) ?? []).length,
         1
      )
      assert.match(
         headerPresentBodyMissing.content,
         /Before the figure\n\n\[Embedded image omitted: figure6\.png\]\n\nFigure 6\. Thirty-day healing outcomes/
      )
      assert.equal(
         (headerPresentBodyMissing.content.match(/\[Embedded image omitted: figure6\.png\]/g) ?? []).length,
         1
      )

      const secondImageMissing = await extractDocumentContent(
         createMinimalDocx([], {}, {
            bodyBlocks: [
               { type: 'paragraph', text: 'First' },
               { type: 'image', fileName: 'one.png' },
               { type: 'paragraph', text: 'Second' },
               { type: 'image', fileName: 'two.png' },
               { type: 'paragraph', text: 'Third' },
            ],
         }),
         'docx',
         {
            parseOffice: async () => ({
               content: [
                  { type: 'paragraph', text: 'First' },
                  { type: 'image', metadata: { attachmentName: 'one.png' } },
                  { type: 'paragraph', text: 'Second' },
                  { type: 'paragraph', text: 'Third' },
               ],
            }),
         }
      )
      assert.equal(secondImageMissing.kind, 'content')
      assert.match(
         secondImageMissing.content,
         /First\n\n\[Embedded image omitted: one\.png\]\n\nSecond\n\n\[Embedded image omitted: two\.png\]\n\nThird/
      )
      assert.equal((secondImageMissing.content.match(/\[Embedded image omitted: one\.png\]/g) ?? []).length, 1)
      assert.equal((secondImageMissing.content.match(/\[Embedded image omitted: two\.png\]/g) ?? []).length, 1)

      const chartMissing = await extractDocumentContent(
         createMinimalDocx([], {}, {
            bodyBlocks: [
               { type: 'paragraph', text: 'Before' },
               { type: 'image', fileName: 'wound.png' },
               { type: 'chart' },
               { type: 'paragraph', text: 'After' },
            ],
         }),
         'docx',
         {
            parseOffice: async () => ({
               content: [
                  { type: 'paragraph', text: 'Before' },
                  { type: 'image', metadata: { attachmentName: 'wound.png' } },
                  { type: 'paragraph', text: 'After' },
               ],
            }),
         }
      )
      assert.equal(chartMissing.kind, 'content')
      assert.match(
         chartMissing.content,
         /Before\n\n\[Embedded image omitted: wound\.png\]\n\n\[Embedded chart omitted\]\n\nAfter/
      )
      assert.equal((chartMissing.content.match(/\[Embedded image omitted: wound\.png\]/g) ?? []).length, 1)
      assert.equal((chartMissing.content.match(/\[Embedded chart omitted\]/g) ?? []).length, 1)

      const inlineImage = await extractDocumentContent(
         createMinimalDocx([], {}, {
            bodyBlocks: [
               {
                  type: 'paragraph',
                  text: 'Before',
                  imageFileName: 'inline.png',
                  after: 'After',
               },
            ],
         }),
         'docx'
      )
      assert.equal(inlineImage.kind, 'content')
      assert.match(
         inlineImage.content,
         /Before\n\n\[Embedded image omitted: inline\.png\]\n\nAfter/
      )
      assert.doesNotMatch(inlineImage.content, /iVBORw0KGgo|word\/media|data:image/)

      const equationBesideImage = createMinimalDocx([], {}, {
         bodyBlocks: [
            {
               type: 'paragraph',
               text: 'Before',
               imageFileName: 'inline.png',
               after: 'After',
            },
         ],
      })
      const preservedEquation = await extractDocumentContent(equationBesideImage, 'docx', {
         parseOffice: async () => ({
            content: [
               {
                  type: 'paragraph',
                  children: [
                     { type: 'text', text: 'Before' },
                     { type: 'equation', text: 'E = mc²' },
                     { type: 'image', metadata: { attachmentName: 'inline.png' } },
                     { type: 'text', text: 'After' },
                  ],
               },
            ],
         }),
      })
      assert.equal(preservedEquation.kind, 'content')
      const equationContent = preservedEquation.content
      const beforeAt = equationContent.indexOf('Before')
      const formulaAt = equationContent.indexOf('E = mc²')
      const imageAt = equationContent.indexOf('[Embedded image omitted: inline.png]')
      const afterAt = equationContent.indexOf('After')
      assert.ok(beforeAt !== -1 && formulaAt !== -1 && imageAt !== -1 && afterAt !== -1)
      assert.ok(beforeAt < formulaAt && formulaAt < imageAt && imageAt < afterAt)
      assert.equal((equationContent.match(/\[Embedded image omitted: inline\.png\]/g) ?? []).length, 1)
      assert.equal((equationContent.match(/E = mc²/g) ?? []).length, 1)

      const missingImageKeepsEquation = await extractDocumentContent(equationBesideImage, 'docx', {
         parseOffice: async () => ({
            content: [
               {
                  type: 'paragraph',
                  children: [
                     { type: 'text', text: 'Before' },
                     { type: 'code', text: 'E = mc²' },
                     { type: 'text', text: 'After' },
                  ],
               },
            ],
         }),
      })
      assert.equal(missingImageKeepsEquation.kind, 'content')
      const filledContent = missingImageKeepsEquation.content
      assert.ok(filledContent.indexOf('Before') < filledContent.indexOf('E = mc²'))
      assert.ok(filledContent.indexOf('E = mc²') < filledContent.indexOf('[Embedded image omitted: inline.png]'))
      assert.ok(filledContent.indexOf('[Embedded image omitted: inline.png]') < filledContent.indexOf('After'))
      assert.equal((filledContent.match(/\[Embedded image omitted: inline\.png\]/g) ?? []).length, 1)

      const dataDescriptorDocx = await extractDocumentContent(
         createMinimalDocx([], {}, {
            dataDescriptors: true,
            bodyBlocks: [
               { type: 'paragraph', text: 'Before the figure' },
               { type: 'image', fileName: 'figure6.png' },
               { type: 'paragraph', text: 'Figure 6. Thirty-day healing outcomes' },
            ],
         }),
         'docx'
      )
      assert.equal(dataDescriptorDocx.kind, 'content')
      assert.match(
         dataDescriptorDocx.content,
         /Before the figure\n\n\[Embedded image omitted: figure6\.png\]\n\nFigure 6\. Thirty-day healing outcomes/
      )

      const compressedXml = 'a'.repeat(MAX_DOCUMENT_SOURCE_BYTES + 8 * 1024 * 1024)
      const zipBomb = createZipArchive({
         '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
`,
         '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`,
         'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>
`,
         'word/document.xml': compressedXml,
      })
      assert.ok(zipBomb.byteLength < 1024 * 1024)
      const bombExtracted = await extractDocumentContent(zipBomb, 'docx', {
         parseOffice: async () => ({
            content: [{ type: 'paragraph', text: 'Safe body' }],
         }),
      })
      assert.equal(bombExtracted.kind, 'content')
      assert.match(bombExtracted.content, /Safe body/)
      assert.doesNotMatch(bombExtracted.content, /aaaa/)
      assert.ok(Buffer.byteLength(bombExtracted.content) < 64 * 1024)

      const controller = new AbortController()
      await assert.rejects(
         extractDocumentContent(
            createMinimalDocx([], {}, {
               bodyBlocks: [
                  { type: 'paragraph', text: 'Review body' },
                  { type: 'image', fileName: 'figure6.png' },
               ],
            }),
            'docx',
            {
               signal: controller.signal,
               parseOffice: async () => {
                  controller.abort()
                  return { content: [{ type: 'paragraph', text: 'Review body' }] }
               },
            }
         ),
         (error: unknown) => error instanceof ClipboardInterruptedError
      )
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
         const outsideDocument = join(await createProject(), 'secret.docx')
         await writeFile(
            outsideDocument,
            createMinimalDocx(['OUTSIDE-SECRET-DOCUMENT'])
         )
         await symlink(outsideDocument, join(repository, 'linked.docx'))

         const bundle = await createMarkdownBundle(repository, [
            { kind: 'new', path: 'linked.txt' },
            { kind: 'new', path: 'linked.docx' },
         ])
         assert.match(bundle, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
         assert.match(bundle, new RegExp(outsideDocument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
         assert.doesNotMatch(bundle, /must-not-be-read/)
         assert.doesNotMatch(bundle, /OUTSIDE-SECRET-DOCUMENT/)
         assert.doesNotMatch(bundle, /Extracted DOCX content/)
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

   it('includes omitted-content assets in multi-repository workspace bundles', async () => {
      const app = await createRepository()
      const api = await createRepository()
      await writeRepositoryFile(app, 'src/app.ts', 'app\n')
      await writeFile(join(app, 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      await writeRepositoryFile(api, 'mark.svg', '<svg></svg>\n')
      await writeFile(join(api, 'brief.docx'), createMinimalDocx(['Workspace document']))

      let bundled = ''
      await runWorkspaceBundleCommand([app, api], undefined, async (content) => {
         bundled = content
      })
      assert.match(bundled, /^# Repository Bundle\n\nRepositories: 2\nFiles: 4/m)
      assert.match(bundled, /### \[NEW\] src\/app\.ts/)
      assert.match(bundled, /\[Binary file: hero\.png - content omitted\]/)
      assert.match(bundled, /```svg\n<svg><\/svg>/)
      assert.match(bundled, /\[Extracted DOCX content\]/)
      assert.match(bundled, /Workspace document/)
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

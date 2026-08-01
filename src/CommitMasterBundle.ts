import { constants } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import {
   escapeDisplayedPath,
   escapeMarkdownHeadingPath,
   isSensitivePath,
   resolveAbsoluteChangedPath,
} from './CommitMasterChangedFiles.js'
import type { FileChange } from './CommitMasterTypes.js'

export const MAX_BUNDLE_FILE_BYTES = 1024 * 1024
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024

const LANGUAGE_BY_SUFFIX: ReadonlyArray<readonly [string, string]> = [
   ['.d.ts', 'ts'],
   ['.md', 'markdown'],
   ['.html', 'html'],
   ['.css', 'css'],
   ['.scss', 'scss'],
   ['.cjs', 'js'],
   ['.mjs', 'js'],
   ['.jsx', 'jsx'],
   ['.js', 'js'],
   ['.tsx', 'tsx'],
   ['.ts', 'ts'],
   ['.vue', 'vue'],
   ['.json', 'json'],
   ['.yaml', 'yaml'],
   ['.yml', 'yaml'],
   ['.xml', 'xml'],
   ['.zsh', 'bash'],
   ['.sh', 'bash'],
   ['.py', 'python'],
   ['.rb', 'ruby'],
   ['.php', 'php'],
   ['.go', 'go'],
   ['.rs', 'rust'],
   ['.java', 'java'],
   ['.kt', 'kotlin'],
   ['.swift', 'swift'],
   ['.sql', 'sql'],
   ['.graphql', 'graphql'],
   ['.gql', 'graphql'],
]

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

interface BundleOptions {
   signal?: AbortSignal
   maxFileBytes?: number
   maxBundleBytes?: number
}

type FileContentResult =
   | { kind: 'content'; content: string; language: string }
   | { kind: 'placeholder'; content: string }

export const detectFenceLanguage = (filePath: string): string => {
   const lowerPath = filePath.toLowerCase()
   return LANGUAGE_BY_SUFFIX.find(([suffix]) => lowerPath.endsWith(suffix))?.[1] ?? 'text'
}

export const createSafeFence = (content: string): string => {
   let longestRun = 0
   for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length)
   return '`'.repeat(Math.max(3, longestRun + 1))
}

const throwIfAborted = (signal?: AbortSignal): void => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
}

const decodeTextFile = (contents: Buffer): string | undefined => {
   for (const byte of contents) {
      if (byte < 9 || (byte > 13 && byte < 32)) return undefined
   }
   try {
      return utf8Decoder.decode(contents)
   } catch {
      return undefined
   }
}

export const fileReadPlaceholder = (error: unknown): string | undefined => {
   const code = (error as NodeJS.ErrnoException | undefined)?.code
   if (code === 'ENOENT' || code === 'ENOTDIR') return '[FILE NOT FOUND]'
   if (
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'EISDIR' ||
      code === 'ELOOP' ||
      code === 'EINVAL' ||
      code === 'EBUSY' ||
      code === 'ESTALE'
   ) {
      return '[FILE UNREADABLE]'
   }
   return undefined
}

const readBoundedFile = async (
   absolutePath: string,
   maxFileBytes: number,
   signal?: AbortSignal
): Promise<Buffer | '[FILE TOO LARGE]' | '[FILE UNREADABLE]'> => {
   const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
   const handle = await open(absolutePath, constants.O_RDONLY | noFollow)
   try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) return '[FILE UNREADABLE]'
      const currentPathMetadata = await lstat(absolutePath)
      if (
         !currentPathMetadata.isFile() ||
         currentPathMetadata.dev !== metadata.dev ||
         currentPathMetadata.ino !== metadata.ino
      ) {
         return '[FILE UNREADABLE]'
      }
      if (metadata.size > maxFileBytes) return '[FILE TOO LARGE]'

      const contents = Buffer.allocUnsafe(maxFileBytes + 1)
      let offset = 0
      while (offset < contents.length) {
         throwIfAborted(signal)
         const { bytesRead } = await handle.read(contents, offset, contents.length - offset, null)
         if (bytesRead === 0) break
         offset += bytesRead
      }
      if (offset > maxFileBytes) return '[FILE TOO LARGE]'
      return contents.subarray(0, offset)
   } finally {
      await handle.close()
   }
}

const readWorkingTreeContent = async (
   absolutePath: string,
   change: FileChange,
   maxFileBytes: number,
   signal?: AbortSignal
): Promise<FileContentResult> => {
   if (isSensitivePath(change.path)) {
      return { kind: 'placeholder', content: '[SENSITIVE FILE OMITTED]' }
   }
   if (change.kind === 'deleted') return { kind: 'placeholder', content: '[FILE DELETED]' }

   try {
      throwIfAborted(signal)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
         return { kind: 'content', content: await readlink(absolutePath), language: 'text' }
      }
      if (!metadata.isFile()) return { kind: 'placeholder', content: '[FILE UNREADABLE]' }

      const contents = await readBoundedFile(absolutePath, maxFileBytes, signal)
      if (typeof contents === 'string') return { kind: 'placeholder', content: contents }
      const decoded = decodeTextFile(contents)
      return decoded === undefined
         ? { kind: 'placeholder', content: '[BINARY FILE OMITTED]' }
         : { kind: 'content', content: decoded, language: detectFenceLanguage(change.path) }
   } catch (error) {
      if (error instanceof ClipboardInterruptedError) throw error
      const placeholder = fileReadPlaceholder(error)
      if (placeholder) return { kind: 'placeholder', content: placeholder }
      throw new CommitMasterError(`Unable to read changed file "${change.path}".`, { cause: error })
   }
}

const validateLimit = (value: number, name: string, maximum: number): number => {
   if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new CommitMasterError(`${name} must be between 0 and ${maximum} bytes.`)
   }
   return value
}

export const createMarkdownBundle = async (
   repositoryRoot: string,
   changes: readonly FileChange[],
   options: BundleOptions = {}
): Promise<string> => {
   const maxFileBytes = validateLimit(
      options.maxFileBytes ?? MAX_BUNDLE_FILE_BYTES,
      'Maximum file size',
      MAX_BUNDLE_FILE_BYTES
   )
   const maxBundleBytes = validateLimit(
      options.maxBundleBytes ?? MAX_BUNDLE_BYTES,
      'Maximum bundle size',
      MAX_BUNDLE_BYTES
   )
   const repositoryHeader = `Repository: ${escapeDisplayedPath(repositoryRoot)}`
   const ending = '\n\n------------------------------'
   let bundleBytes = Buffer.byteLength(repositoryHeader) + Buffer.byteLength(ending)
   const sections: string[] = []

   for (const change of changes) {
      throwIfAborted(options.signal)
      const absolutePath = resolveAbsoluteChangedPath(repositoryRoot, change.path)
      const result = await readWorkingTreeContent(
         absolutePath,
         change,
         maxFileBytes,
         options.signal
      )
      const content = result.content
      const language = result.kind === 'content' ? result.language : 'text'
      const fence = createSafeFence(content)
      const contentWithNewline = content.endsWith('\n') ? content : `${content}\n`
      const headingPath = escapeMarkdownHeadingPath(absolutePath)
      const section = `### ${headingPath}\n\n${fence}${language}\n${contentWithNewline}${fence}`
      bundleBytes += Buffer.byteLength('\n\n') + Buffer.byteLength(section)
      if (bundleBytes > maxBundleBytes) {
         throw new CommitMasterError(
            'Markdown bundle exceeds the 10 MiB safety limit. Reduce the number or size of changed files and try again.'
         )
      }
      sections.push(section)
   }

   return `${repositoryHeader}\n\n${sections.join('\n\n')}${ending}`
}

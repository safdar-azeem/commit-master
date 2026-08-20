import path from 'node:path'
import { CommitMasterError } from './CommitMasterErrors.js'
import { readChanges } from './CommitMasterRepository.js'
import type { FileChange } from './CommitMasterTypes.js'

const IGNORED_FILE_NAMES = new Set([
   'yarn.lock',
   'pnpm-lock.yaml',
   'bun.lockb',
   'cargo.lock',
   'generated.ts',
   'mongoose.gen.ts',
   'resolvers.generated.ts',
   'typedefs.generated.ts',
   'types.generated.ts',
   'tsconfig.tsbuildinfo',
   'tsconfig.node.tsbuildinfo',
   '.ds_store',
])

const IGNORED_FILE_SUFFIXES = ['.log', '.tag', '.csv'] as const

const OMITTED_BINARY_CONTENT_SUFFIXES = [
   '.jpg',
   '.jpeg',
   '.png',
   '.gif',
   '.webp',
   '.avif',
   '.bmp',
   '.ico',
   '.tif',
   '.tiff',
   '.heic',
   '.heif',
   '.mp4',
   '.mov',
   '.avi',
   '.mkv',
   '.webm',
   '.m4v',
   '.mpeg',
   '.mpg',
   '.wmv',
   '.flv',
   '.mp3',
   '.wav',
   '.m4a',
   '.aac',
   '.flac',
   '.ogg',
   '.opus',
   '.wma',
   '.aiff',
   '.aif',
   '.onnx',
   '.zip',
   '.tar',
   '.gz',
   '.tgz',
   '.bz2',
   '.xz',
   '.7z',
   '.rar',
   '.db',
   '.sqlite',
   '.sqlite3',
   '.wasm',
   '.exe',
   '.dll',
   '.dylib',
   '.so',
] as const

const EXTRACTABLE_DOCUMENT_SUFFIXES = ['.docx', '.pdf', '.pptx'] as const

const TEXTUAL_ASSET_SUFFIXES = ['.svg'] as const

const IGNORED_DIRECTORY_PATHS = [
   '_locales',
   'src-tauri/target',
   'gen',
   'temp',
   'ffmpeg',
   'dist',
   '.xcode',
   'vendor/bundle',
   '.git',
   'pods',
   '.nuxt',
   '.next',
   '.idea',
   '.bundle',
   'node_modules',
   'cache',
] as const

const SENSITIVE_FILE_NAMES = new Set([
   '.env',
   'id_rsa',
   'id_ed25519',
   'credentials.json',
   'service-account.json',
   'secrets.json',
   '.npmrc',
   '.pypirc',
   '.netrc',
])

const SENSITIVE_FILE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore'] as const

const normalizeGitPath = (filePath: string): string =>
   filePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')

const comparePaths = (left: FileChange, right: FileChange): number =>
   left.path < right.path ? -1 : left.path > right.path ? 1 : 0

const lowerFileName = (filePath: string): string => {
   const lowerPath = normalizeGitPath(filePath).toLowerCase()
   return lowerPath.split('/').at(-1) ?? lowerPath
}

const hasAnySuffix = (lowerName: string, suffixes: readonly string[]): boolean =>
   suffixes.some((suffix) => lowerName.endsWith(suffix))

const isIgnoredDirectoryPath = (filePath: string): boolean => {
   const surrounded = `/${normalizeGitPath(filePath).toLowerCase()}/`
   return IGNORED_DIRECTORY_PATHS.some((directory) =>
      surrounded.includes(`/${directory}/`)
   )
}

const isGeneratedOrNamedIgnoredPath = (lowerName: string): boolean => {
   if (IGNORED_FILE_NAMES.has(lowerName)) return true
   if (lowerName.endsWith('.generated.ts')) return true
   return lowerName.startsWith('vite.config.ts.timestamp-')
}

const isPathsOmittedAssetPath = (filePath: string): boolean => {
   const lowerName = lowerFileName(filePath)
   return (
      hasAnySuffix(lowerName, OMITTED_BINARY_CONTENT_SUFFIXES) ||
      hasAnySuffix(lowerName, TEXTUAL_ASSET_SUFFIXES) ||
      hasAnySuffix(lowerName, EXTRACTABLE_DOCUMENT_SUFFIXES)
   )
}

export type ExtractableDocumentType = 'docx' | 'pdf' | 'pptx'

export const detectExtractableDocumentType = (
   filePath: string
): ExtractableDocumentType | undefined => {
   const lowerName = lowerFileName(filePath)
   const suffix = EXTRACTABLE_DOCUMENT_SUFFIXES.find((item) => lowerName.endsWith(item))
   return suffix === undefined ? undefined : (suffix.slice(1) as ExtractableDocumentType)
}

export const isExtractableDocumentPath = (filePath: string): boolean =>
   detectExtractableDocumentType(filePath) !== undefined

export const isOmittedBinaryContentPath = (filePath: string): boolean =>
   hasAnySuffix(lowerFileName(filePath), OMITTED_BINARY_CONTENT_SUFFIXES)

export const isBundleExcludedPath = (filePath: string): boolean => {
   const lowerName = lowerFileName(filePath)
   if (isGeneratedOrNamedIgnoredPath(lowerName)) return true
   if (hasAnySuffix(lowerName, IGNORED_FILE_SUFFIXES)) return true
   return isIgnoredDirectoryPath(filePath)
}

export const isDefaultIgnoredPath = (filePath: string): boolean =>
   isBundleExcludedPath(filePath) || isPathsOmittedAssetPath(filePath)

export const isSensitivePath = (filePath: string): boolean => {
   const lowerName = normalizeGitPath(filePath).toLowerCase().split('/').at(-1) ?? ''
   if (SENSITIVE_FILE_NAMES.has(lowerName)) return true
   if (lowerName.startsWith('.env.')) return true
   if (lowerName.startsWith('service-account') && lowerName.endsWith('.json')) return true
   return SENSITIVE_FILE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
}

export const escapeDisplayedPath = (filePath: string): string =>
   filePath.replace(/[\u0000-\u001f\u007f]/g, (character) => {
      switch (character) {
         case '\n':
            return '\\n'
         case '\r':
            return '\\r'
         case '\t':
            return '\\t'
         default:
            return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
      }
   })

export const escapeMarkdownHeadingPath = (filePath: string): string =>
   escapeDisplayedPath(filePath).replace(/([`*_{}\[\]<>#!|])/g, '\\$1')

export type EligibleChangeMode = 'paths' | 'bundle'

export const filterEligibleChanges = (
   changes: readonly FileChange[],
   mode: EligibleChangeMode = 'paths'
): FileChange[] => {
   const shouldSkip = mode === 'bundle' ? isBundleExcludedPath : isDefaultIgnoredPath
   const byCurrentPath = new Map<string, FileChange>()
   for (const change of changes) {
      if (shouldSkip(change.path)) continue
      const existing = byCurrentPath.get(change.path)
      if (!existing || existing.kind === 'deleted') byCurrentPath.set(change.path, change)
   }
   return [...byCurrentPath.values()].sort(comparePaths)
}

export const collectEligibleChanges = async (
   repositoryRoot: string,
   mode: EligibleChangeMode = 'paths'
): Promise<FileChange[]> =>
   filterEligibleChanges(await readChanges({ root: repositoryRoot }), mode)

export const resolveAbsoluteChangedPath = (
   repositoryRoot: string,
   relativePath: string
): string => {
   const absolutePath = path.resolve(repositoryRoot, relativePath)
   const relativeToRoot = path.relative(repositoryRoot, absolutePath)
   if (
      relativeToRoot === '' ||
      relativeToRoot === '..' ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
   ) {
      throw new CommitMasterError(`Git returned a path outside the repository: "${relativePath}".`)
   }
   return absolutePath
}

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
   'tsconfig.tsbuildinfo',
   'tsconfig.node.tsbuildinfo',
   '.ds_store',
])

const IGNORED_FILE_SUFFIXES = [
   '.log',
   '.sql',
   '.onnx',
   '.tag',
   '.pdf',
   '.docx',
   '.csv',
   '.jpg',
   '.jpeg',
   '.png',
   '.gif',
   '.webp',
   '.svg',
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

const IGNORED_DIRECTORY_PATHS = [
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
] as const

const normalizeGitPath = (filePath: string): string =>
   filePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')

const comparePaths = (left: FileChange, right: FileChange): number =>
   left.path < right.path ? -1 : left.path > right.path ? 1 : 0

export const isDefaultIgnoredPath = (filePath: string): boolean => {
   const normalized = normalizeGitPath(filePath)
   const lowerPath = normalized.toLowerCase()
   const lowerName = lowerPath.split('/').at(-1) ?? lowerPath

   if (IGNORED_FILE_NAMES.has(lowerName)) return true
   if (lowerName.endsWith('.generated.ts')) return true
   if (lowerName.startsWith('vite.config.ts.timestamp-')) return true
   if (IGNORED_FILE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) return true

   const surrounded = `/${normalized}/`
   return IGNORED_DIRECTORY_PATHS.some((directory) =>
      surrounded.includes(`/${directory}/`)
   )
}

export const filterEligibleChanges = (changes: readonly FileChange[]): FileChange[] => {
   const byCurrentPath = new Map<string, FileChange>()
   for (const change of changes) {
      if (isDefaultIgnoredPath(change.path)) continue
      const existing = byCurrentPath.get(change.path)
      if (!existing || existing.kind === 'deleted') byCurrentPath.set(change.path, change)
   }
   return [...byCurrentPath.values()].sort(comparePaths)
}

export const collectEligibleChanges = async (repositoryRoot: string): Promise<FileChange[]> =>
   filterEligibleChanges(await readChanges({ root: repositoryRoot }))

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

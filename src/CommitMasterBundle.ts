import { lstat, readFile, readlink } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { CommitMasterError } from './CommitMasterErrors.js'
import { resolveAbsoluteChangedPath } from './CommitMasterChangedFiles.js'
import type { FileChange } from './CommitMasterTypes.js'

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

export const detectFenceLanguage = (filePath: string): string => {
   const lowerPath = filePath.toLowerCase()
   return LANGUAGE_BY_SUFFIX.find(([suffix]) => lowerPath.endsWith(suffix))?.[1] ?? 'text'
}

export const createSafeFence = (content: string): string => {
   let longestRun = 0
   for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length)
   return '`'.repeat(Math.max(3, longestRun + 1))
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

const readWorkingTreeContent = async (
   absolutePath: string,
   change: FileChange
): Promise<{ content: string; language: string }> => {
   if (change.kind === 'deleted') return { content: '[FILE DELETED]', language: 'text' }

   try {
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
         return { content: await readlink(absolutePath), language: 'text' }
      }
      if (!metadata.isFile()) return { content: '[BINARY FILE OMITTED]', language: 'text' }
      const contents = await readFile(absolutePath)
      const decoded = decodeTextFile(contents)
      return decoded === undefined
         ? { content: '[BINARY FILE OMITTED]', language: 'text' }
         : { content: decoded, language: detectFenceLanguage(change.path) }
   } catch (error) {
      throw new CommitMasterError(`Unable to read changed file "${change.path}".`, { cause: error })
   }
}

export const createMarkdownBundle = async (
   repositoryRoot: string,
   changes: readonly FileChange[]
): Promise<string> => {
   const sections: string[] = []
   for (const change of changes) {
      const absolutePath = resolveAbsoluteChangedPath(repositoryRoot, change.path)
      const { content, language } = await readWorkingTreeContent(absolutePath, change)
      const fence = createSafeFence(content)
      const contentWithNewline = content.endsWith('\n') ? content : `${content}\n`
      sections.push(`### ${absolutePath}\n\n${fence}${language}\n${contentWithNewline}${fence}`)
   }
   return `Repository: ${repositoryRoot}\n\n${sections.join('\n\n')}\n\n------------------------------`
}

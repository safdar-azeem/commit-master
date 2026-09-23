import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import { commitMasterFilebundleDirectory } from './CommitMasterUserPaths.js'

const safeFolderName = (root: string): string =>
   path.basename(root)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)

const timestamp = (date: Date): string =>
   `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`

const containsDirectory = (root: string, directory: string): boolean => {
   const relative = path.relative(root, directory)
   return relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const canonicalDirectoryEvenIfMissing = async (directory: string): Promise<string> => {
   try {
      return await realpath(directory)
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(directory)
      if (parent === directory) throw error
      return path.join(await canonicalDirectoryEvenIfMissing(parent), path.basename(directory))
   }
}

const fallbackDirectory = (): string => {
   const identity = process.platform === 'win32'
      ? userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)
      : String(process.getuid?.() ?? userInfo().uid)
   return path.join(tmpdir(), `commit-master-${identity}`, 'filebundles')
}

const storageDirectoryOutside = async (root: string, preferred: string): Promise<string> => {
   const canonicalRoot = await realpath(root)
   for (const candidate of [preferred, fallbackDirectory()]) {
      const prospective = await canonicalDirectoryEvenIfMissing(candidate)
      if (containsDirectory(canonicalRoot, prospective)) continue
      await mkdir(candidate, { recursive: true })
      const actual = await realpath(candidate)
      if (!containsDirectory(canonicalRoot, actual)) return actual
   }
   throw new CommitMasterError('No user cache directory outside the selected folder is available.')
}

export const writeFilebundleMarkdown = async (
   root: string,
   markdown: string,
   signal?: AbortSignal,
   directory = commitMasterFilebundleDirectory()
): Promise<string> => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
   try {
      directory = await storageDirectoryOutside(root, directory)
   } catch (error) {
      if (error instanceof CommitMasterError) throw error
      throw new CommitMasterError('Unable to prepare the Markdown bundle directory.', { cause: error })
   }
   const folderName = safeFolderName(root)
   const basename = `filebundle-${folderName ? `${folderName}-` : ''}${timestamp(new Date())}-${randomUUID().slice(0, 8)}.md`
   const target = path.join(directory, basename)
   const temporary = path.join(directory, `.${basename}.${randomUUID()}.tmp`)
   try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx', signal })
      if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
      await rename(temporary, target)
      return target
   } catch (error) {
      if (signal?.aborted || error instanceof ClipboardInterruptedError) {
         throw new ClipboardInterruptedError({ cause: error })
      }
      throw new CommitMasterError('Unable to write the generated Markdown file.', { cause: error })
   } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
         if (error.code !== 'ENOENT') throw error
      })
   }
}

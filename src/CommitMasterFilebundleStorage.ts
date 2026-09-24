import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ClipboardInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import { commitMasterFilebundleDirectory } from './CommitMasterUserPaths.js'

const lockfile = createRequire(import.meta.url)('proper-lockfile') as typeof import('proper-lockfile')
const LOCK_WAIT_MS = 120_000
const LOCK_STALE_MS = 30_000

const throwIfCancelled = (signal?: AbortSignal): void => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
}

const acquireCacheLock = async (
   directory: string,
   signal?: AbortSignal
): Promise<{ release: () => Promise<void>; assertOwned: () => void }> => {
   const deadline = Date.now() + LOCK_WAIT_MS
   let compromised: Error | undefined
   while (true) {
      throwIfCancelled(signal)
      try {
         const release = await lockfile.lock(directory, {
            lockfilePath: path.join(directory, '.filebundle.lock'),
            stale: LOCK_STALE_MS,
            update: 5_000,
            retries: 0,
            onCompromised: (error: Error) => { compromised = error },
         })
         return {
            release,
            assertOwned: () => {
               throwIfCancelled(signal)
               if (compromised) {
                  throw new CommitMasterError('The filebundle cache lock was lost.', { cause: compromised })
               }
            },
         }
      } catch (error) {
         if (signal?.aborted) throw new ClipboardInterruptedError({ cause: error })
         if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') {
            throw new CommitMasterError('Unable to lock the filebundle cache.', { cause: error })
         }
         if (Date.now() >= deadline) {
            throw new CommitMasterError('Timed out waiting for another filebundle operation to finish.')
         }
         try {
            await delay(100, undefined, { signal })
         } catch (waitError) {
            if (signal?.aborted) throw new ClipboardInterruptedError({ cause: waitError })
            throw waitError
         }
      }
   }
}

const safeFolderName = (root: string): string =>
   path.basename(root)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)

const generatedBundleName = /^filebundle(?:-[a-z0-9_-]{1,48})?\.md$/
const legacyBundleName = /^filebundle(?:-[a-z0-9_-]{1,48})?-\d{8}-\d{6}-[a-f0-9]{8}\.md$/
const abandonedTemporaryName = /^\.filebundle-(?:writing|replacing)-[a-f0-9-]{36}\.tmp$/

const cleanPreviousBundles = async (directory: string, currentName: string): Promise<void> => {
   for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === currentName || !entry.isFile() ||
          (!generatedBundleName.test(entry.name) &&
           !legacyBundleName.test(entry.name) &&
           !abandonedTemporaryName.test(entry.name))) {
         continue
      }
      await unlink(path.join(directory, entry.name))
   }
}

const replaceCompletedBundle = async (temporary: string, target: string): Promise<void> => {
   try {
      await rename(temporary, target)
      return
   } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(code ?? '')) {
         throw error
      }
   }

   // Windows may refuse rename-over-existing. Keep the completed file in a
   // private backup until the replacement has reached its final name.
   const existing = await lstat(target)
   if (!existing.isFile()) throw new CommitMasterError('The existing bundle target is not a regular file.')
   const backup = path.join(path.dirname(target), `.filebundle-replacing-${randomUUID()}.tmp`)
   await rename(target, backup)
   try {
      await rename(temporary, target)
   } catch (error) {
      await rename(backup, target)
      throw error
   }
   await unlink(backup)
}

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

const writeLockedBundle = async (
   root: string,
   markdown: string,
   directory: string,
   signal?: AbortSignal,
   writeTemporary: typeof writeFile = writeFile
): Promise<string> => {
   const folderName = safeFolderName(root)
   const basename = folderName ? `filebundle-${folderName}.md` : 'filebundle.md'
   const target = path.join(directory, basename)
   const temporary = path.join(directory, `.filebundle-writing-${randomUUID()}.tmp`)
   try {
      await mkdir(directory, { recursive: true })
      await writeTemporary(temporary, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx', signal })
      throwIfCancelled(signal)
      await replaceCompletedBundle(temporary, target)
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
   try {
      await cleanPreviousBundles(directory, basename)
   } catch (error) {
      throw new CommitMasterError(`The Markdown file was saved at ${target}, but stale filebundle cache files could not be removed.`, { cause: error })
   }
   return target
}

/** Holds the cross-process cache lease through delivery so another run cannot remove its file first. */
export const withFilebundleMarkdown = async <T>(
   root: string,
   markdown: string,
   signal: AbortSignal | undefined,
   deliver: (filePath: string) => Promise<T>,
   directory = commitMasterFilebundleDirectory(),
   writeTemporary: typeof writeFile = writeFile
): Promise<T> => {
   throwIfCancelled(signal)
   try {
      directory = await storageDirectoryOutside(root, directory)
   } catch (error) {
      if (error instanceof CommitMasterError) throw error
      throw new CommitMasterError('Unable to prepare the Markdown bundle directory.', { cause: error })
   }
   const lease = await acquireCacheLock(directory, signal)
   try {
      lease.assertOwned()
      const filePath = await writeLockedBundle(root, markdown, directory, signal, writeTemporary)
      lease.assertOwned()
      const result = await deliver(filePath)
      lease.assertOwned()
      return result
   } finally {
      await lease.release()
   }
}

export const writeFilebundleMarkdown = (
   root: string,
   markdown: string,
   signal?: AbortSignal,
   directory = commitMasterFilebundleDirectory(),
   writeTemporary: typeof writeFile = writeFile
): Promise<string> =>
   withFilebundleMarkdown(root, markdown, signal, async (filePath) => filePath, directory, writeTemporary)

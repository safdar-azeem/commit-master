import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CommitMasterError } from './CommitMasterErrors.js'
import { commitMasterConfigDirectory } from './CommitMasterUserPaths.js'

export type FilebundleOutput = 'file' | 'text'

const settingsPath = (configDirectory: string): string => path.join(configDirectory, 'settings.json')

const isRecord = (value: unknown): value is Record<string, unknown> =>
   value !== null && typeof value === 'object' && !Array.isArray(value)

const readSettings = async (configDirectory: string): Promise<Record<string, unknown>> => {
   let contents: string
   try {
      contents = await readFile(settingsPath(configDirectory), 'utf8')
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new CommitMasterError('Unable to read Commit Master settings.', { cause: error })
   }
   try {
      const parsed: unknown = JSON.parse(contents)
      if (!isRecord(parsed)) throw new Error('Settings must be an object.')
      if (parsed.filebundle !== undefined) {
         if (!isRecord(parsed.filebundle)) throw new Error('filebundle settings must be an object.')
         const output = parsed.filebundle.output
         if (output !== undefined && output !== 'file' && output !== 'text') {
            throw new Error('Invalid filebundle output.')
         }
      }
      return parsed
   } catch (error) {
      throw new CommitMasterError('Commit Master settings are invalid.', { cause: error })
   }
}

export const readFilebundleOutput = async (
   configDirectory = commitMasterConfigDirectory()
): Promise<FilebundleOutput> => {
   const settings = await readSettings(configDirectory)
   const filebundle = settings.filebundle as Record<string, unknown> | undefined
   return (filebundle?.output as FilebundleOutput | undefined) ?? 'file'
}

export const saveFilebundleOutput = async (
   output: FilebundleOutput,
   configDirectory = commitMasterConfigDirectory()
): Promise<void> => {
   if (output !== 'file' && output !== 'text') {
      throw new CommitMasterError('filebundle output must be file or text.')
   }
   const settings = await readSettings(configDirectory)
   const filebundle = (settings.filebundle as Record<string, unknown> | undefined) ?? {}
   const target = settingsPath(configDirectory)
   const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
   try {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(
         temporary,
         `${JSON.stringify({ ...settings, filebundle: { ...filebundle, output } }, null, 2)}\n`,
         { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      await rename(temporary, target)
   } catch (error) {
      throw new CommitMasterError('Unable to save Commit Master settings.', { cause: error })
   } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
         if (error.code !== 'ENOENT') throw error
      })
   }
}

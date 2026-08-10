import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { CommitMasterError } from './CommitMasterErrors.js'
import { resolveRepositoryRoot } from './CommitMasterRepository.js'
import type { SavedWorkspace } from './CommitMasterTypes.js'

const DISCOVERY_DEPTH = 3
const DISCOVERY_IGNORED_DIRECTORIES = new Set([
   '.git',
   'node_modules',
   'dist',
   'build',
   'generated',
   'out',
   'coverage',
   '.next',
   '.nuxt',
   'vendor',
   'target',
   '.cache',
   '.turbo',
])
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const workspaceStorePath = (): string => {
   const configRoot =
      process.platform === 'win32'
         ? process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
         : process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
   return path.join(configRoot, 'commit-master', 'workspaces.json')
}

const validateWorkspaceName = (name: string): string => {
   if (!WORKSPACE_NAME.test(name)) {
      throw new CommitMasterError(
         'Workspace names may contain letters, numbers, hyphens, and underscores, and must start with a letter or number.'
      )
   }
   return name
}

const canonicalPath = async (target: string): Promise<string> => {
   try {
      return await realpath(target)
   } catch (error) {
      throw new CommitMasterError(`Path does not exist: ${target}`, { cause: error })
   }
}

export const resolveWorkspaceRepository = async (target: string): Promise<string> => {
   const absoluteTarget = await canonicalPath(path.resolve(target))
   const metadata = await stat(absoluteTarget)
   if (!metadata.isDirectory()) throw new CommitMasterError(`Repository path is not a directory: ${absoluteTarget}`)
   const root = await resolveRepositoryRoot(absoluteTarget)
   if (!root) throw new CommitMasterError(`Not a Git repository: ${absoluteTarget}`)
   return canonicalPath(root)
}

const deduplicateRepositories = async (repositories: readonly string[]): Promise<string[]> => {
   const unique = new Map<string, string>()
   for (const repository of repositories) {
      const canonical = await canonicalPath(repository)
      unique.set(process.platform === 'win32' ? canonical.toLowerCase() : canonical, canonical)
   }
   return [...unique.values()].sort((left, right) => left.localeCompare(right))
}

export const resolveExplicitRepositories = async (
   targets: readonly string[]
): Promise<string[]> => {
   if (targets.length === 0) throw new CommitMasterError('Specify at least one repository path.')
   return deduplicateRepositories(await Promise.all(targets.map(resolveWorkspaceRepository)))
}

export const discoverWorkspaceRepositories = async (workspace: string): Promise<string[]> => {
   const root = await canonicalPath(path.resolve(workspace))
   const workspaceMetadata = await stat(root).catch((error: unknown) => {
      throw new CommitMasterError(`Workspace does not exist: ${root}`, { cause: error })
   })
   if (!workspaceMetadata.isDirectory()) throw new CommitMasterError(`Workspace is not a directory: ${root}`)

   const repositories: string[] = []
   const visit = async (directory: string, depth: number): Promise<void> => {
      const repositoryRoot = await resolveRepositoryRoot(directory)
      if (repositoryRoot) {
         const canonicalRepositoryRoot = await canonicalPath(repositoryRoot)
         if (canonicalRepositoryRoot === directory) {
            repositories.push(canonicalRepositoryRoot)
            return
         }
      }
      if (depth >= DISCOVERY_DEPTH) return

      let entries: Dirent[]
      try {
         entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
         throw new CommitMasterError(`Unable to scan workspace directory: ${directory}`, { cause: error })
      }
      for (const entry of entries) {
         if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)) {
            continue
         }
         await visit(path.join(directory, entry.name), depth + 1)
      }
   }

   await visit(root, 0)
   const resolved = await deduplicateRepositories(repositories)
   if (resolved.length === 0) {
      throw new CommitMasterError(`No Git repositories found under workspace: ${root}`)
   }
   return resolved
}

const parseWorkspaces = (contents: string): SavedWorkspace[] => {
   let parsed: unknown
   try {
      parsed = JSON.parse(contents)
   } catch (error) {
      throw new CommitMasterError('Saved workspace configuration is invalid.', { cause: error })
   }
   if (!Array.isArray(parsed)) throw new CommitMasterError('Saved workspace configuration is invalid.')
   const workspaces: SavedWorkspace[] = []
   for (const entry of parsed) {
      if (
         !entry ||
         typeof entry !== 'object' ||
         typeof (entry as SavedWorkspace).name !== 'string' ||
         !Array.isArray((entry as SavedWorkspace).repositories) ||
         !(entry as SavedWorkspace).repositories.every((repository) => typeof repository === 'string')
      ) {
         throw new CommitMasterError('Saved workspace configuration is invalid.')
      }
      workspaces.push({
         name: validateWorkspaceName((entry as SavedWorkspace).name),
         repositories: [...(entry as SavedWorkspace).repositories],
      })
   }
   return workspaces
}

export const readSavedWorkspaces = async (): Promise<SavedWorkspace[]> => {
   try {
      return parseWorkspaces(await readFile(workspaceStorePath(), 'utf8'))
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
   }
}

const writeSavedWorkspaces = async (workspaces: readonly SavedWorkspace[]): Promise<void> => {
   const target = workspaceStorePath()
   await mkdir(path.dirname(target), { recursive: true })
   const temporary = `${target}.${process.pid}.tmp`
   await writeFile(temporary, `${JSON.stringify(workspaces, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
   })
   await rename(temporary, target)
}

export const saveWorkspace = async (
   name: string,
   repositories: readonly string[]
): Promise<void> => {
   validateWorkspaceName(name)
   const normalized = await deduplicateRepositories(repositories)
   const existing = await readSavedWorkspaces()
   await writeSavedWorkspaces([
      ...existing.filter((workspace) => workspace.name !== name),
      { name, repositories: normalized },
   ])
}

export const loadSavedWorkspace = async (name: string): Promise<string[]> => {
   validateWorkspaceName(name)
   const workspace = (await readSavedWorkspaces()).find((candidate) => candidate.name === name)
   if (!workspace) throw new CommitMasterError(`Saved workspace "${name}" was not found.`)
   const missing: string[] = []
   const repositories: string[] = []
   for (const repository of workspace.repositories) {
      try {
         repositories.push(await resolveWorkspaceRepository(repository))
      } catch {
         missing.push(repository)
      }
   }
   if (missing.length > 0) {
      throw new CommitMasterError(
         `Saved workspace "${name}" has unavailable repositories:\n${missing.map((repository) => `  ${repository}`).join('\n')}`
      )
   }
   return deduplicateRepositories(repositories)
}

export const deleteSavedWorkspace = async (name: string): Promise<void> => {
   validateWorkspaceName(name)
   const workspaces = await readSavedWorkspaces()
   if (!workspaces.some((workspace) => workspace.name === name)) {
      throw new CommitMasterError(`Saved workspace "${name}" was not found.`)
   }
   await writeSavedWorkspaces(workspaces.filter((workspace) => workspace.name !== name))
}

import { commitChanges } from './CommitMasterCommitService.js'
import { ensureGitRepository } from './CommitMasterBootstrap.js'
import {
   runClipboardCommand,
   runWorkspaceBundleCommand,
   type ClipboardCommandName,
} from './CommitMasterClipboardCommands.js'
import { createExpandableDateSchedule } from './CommitMasterDates.js'
import {
   ClipboardInterruptedError,
   CommitInterruptedError,
   CommitMasterError,
   CommitOutcomeUnknownError,
   StashInterruptedError,
   StashOutcomeUnknownError,
} from './CommitMasterErrors.js'
import { InterruptionController } from './CommitMasterInterruption.js'
import { createCommitMessage } from './CommitMasterMessages.js'
import { type CommitspanOutputDetails } from './CommitMasterOutput.js'
import { CommitProgressReporter } from './CommitMasterProgress.js'
import {
   prepareRepository,
   readChanges,
   validateCommitReadiness,
} from './CommitMasterRepository.js'
import type { CommitRequest } from './CommitMasterTypes.js'
import { DEFAULT_STASH_TITLE, runStashCommand } from './CommitMasterStash.js'
import {
   deleteSavedWorkspace,
   discoverWorkspaceRepositories,
   loadSavedWorkspace,
   readSavedWorkspaces,
   resolveExplicitRepositories,
   saveWorkspace,
} from './CommitMasterWorkspaces.js'

export type CommandName = 'gitspan' | 'gitauto' | ClipboardCommandName | 'gitstash'

const GITSTASH_USAGE = `Usage:
  gitstash
  gitstash "stash title"`

export const USAGE = `Usage:
  gitspan <duration> <commits-per-day>
  gitauto
  gitpaths
  gitbundle
  gitbundle <repository-path> [...repository-path]
  gitbundle --all [workspace-path]
  gitbundle --save <name> <repository-path> [...repository-path]
  gitbundle --all --save <name> [workspace-path]
  gitbundle @<workspace-name>
  gitbundle --list
  gitbundle --delete <workspace-name>
  gitstash ["stash title"]

Examples:
  gitspan 10 5
  gitauto
  gitpaths
  gitbundle
  gitbundle ./app ./api
  gitbundle --all ./workspace
  gitbundle --all --save erp
  gitbundle @erp
  gitstash "Work in progress"`

const positiveInteger = (value: string | undefined): number | undefined => {
   if (!value || !/^[1-9]\d*$/.test(value)) return undefined
   const parsed = Number(value)
   return Number.isSafeInteger(parsed) ? parsed : undefined
}

const parseGitspanArguments = (
   args: readonly string[]
): { duration: number; commitsPerDay: number } => {
   if (args.length !== 2) throw new CommitMasterError(`Invalid arguments.\n\n${USAGE}`)
   const duration = positiveInteger(args[0])
   const commitsPerDay = positiveInteger(args[1])
   if (duration === undefined || commitsPerDay === undefined) {
      throw new CommitMasterError(
         `Duration and commits-per-day must be whole integers greater than zero.\n\n${USAGE}`
      )
   }
   if (duration > Math.floor(Number.MAX_SAFE_INTEGER / commitsPerDay)) {
      throw new CommitMasterError(`The requested capacity is too large.\n\n${USAGE}`)
   }
   return { duration, commitsPerDay }
}

type GitbundleArguments =
   | { kind: 'single' }
   | { kind: 'explicit'; paths: string[]; saveName?: string }
   | { kind: 'discover'; workspacePath: string; saveName?: string }
   | { kind: 'saved'; name: string }
   | { kind: 'list' }
   | { kind: 'delete'; name: string }

const gitbundleUsageError = (): CommitMasterError =>
   new CommitMasterError(`Invalid gitbundle arguments.\n\n${USAGE}`)

const parseGitbundleArguments = (args: readonly string[], cwd: string): GitbundleArguments => {
   if (args.length === 0) return { kind: 'single' }
   if (args[0] === '--list') {
      if (args.length !== 1) throw gitbundleUsageError()
      return { kind: 'list' }
   }
   if (args[0] === '--delete') {
      if (args.length !== 2) throw gitbundleUsageError()
      return { kind: 'delete', name: args[1] ?? '' }
   }
   if (args[0]?.startsWith('@')) {
      if (args.length !== 1 || args[0].length === 1) throw gitbundleUsageError()
      return { kind: 'saved', name: args[0].slice(1) }
   }

   let all = false
   let saveName: string | undefined
   const paths: string[] = []
   for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]
      if (argument === '--all') {
         if (all) throw gitbundleUsageError()
         all = true
         continue
      }
      if (argument === '--save') {
         if (saveName !== undefined || index + 1 >= args.length) throw gitbundleUsageError()
         const requestedName = args[index + 1]
         if (!requestedName) throw gitbundleUsageError()
         saveName = requestedName
         index += 1
         continue
      }
      if (argument?.startsWith('--') || !argument) throw gitbundleUsageError()
      paths.push(argument)
   }
   if (all) {
      if (paths.length > 1) throw gitbundleUsageError()
      return { kind: 'discover', workspacePath: paths[0] ?? cwd, saveName }
   }
   if (paths.length === 0) throw gitbundleUsageError()
   return { kind: 'explicit', paths, saveName }
}

const runGitbundle = async (
   args: readonly string[],
   cwd: string,
   interruption: InterruptionController
): Promise<void> => {
   const parsed = parseGitbundleArguments(args, cwd)
   if (parsed.kind === 'list') {
      const workspaces = await readSavedWorkspaces()
      if (workspaces.length === 0) {
         console.log('No saved workspaces.')
         return
      }
      for (const workspace of workspaces) {
         console.log(`${workspace.name}: ${workspace.repositories.length} repositories`)
         for (const repository of workspace.repositories) console.log(`  ${repository}`)
      }
      return
   }
   if (parsed.kind === 'delete') {
      await deleteSavedWorkspace(parsed.name)
      console.log(`Saved workspace "${parsed.name}" deleted.`)
      return
   }
   if (parsed.kind === 'single') {
      if (!(await ensureGitRepository(cwd, interruption))) return
      interruption.throwIfInterrupted(0, 0)
      await runClipboardCommand('gitbundle', cwd, interruption.signal)
      return
   }

   const repositories =
      parsed.kind === 'saved'
         ? await loadSavedWorkspace(parsed.name)
         : parsed.kind === 'discover'
           ? await discoverWorkspaceRepositories(parsed.workspacePath)
           : await resolveExplicitRepositories(parsed.paths)
   if (parsed.kind !== 'saved' && parsed.saveName) {
      await saveWorkspace(parsed.saveName, repositories)
      console.log(`Saved workspace "${parsed.saveName}" with ${repositories.length} repositories.`)
   }
   interruption.throwIfInterrupted(0, 0)
   await runWorkspaceBundleCommand(repositories, interruption.signal)
}

export const runCommand = async (
   command: CommandName,
   args: readonly string[],
   interruption: InterruptionController
): Promise<void> => {
   if (command === 'gitbundle') {
      await runGitbundle(args, process.cwd(), interruption)
      return
   }
   const span = command === 'gitspan' ? parseGitspanArguments(args) : undefined
   const stash =
      command === 'gitstash'
         ? (() => {
              if (args.length > 1) throw new CommitMasterError(GITSTASH_USAGE)
              return {
                 title: args.length === 1 ? (args[0] ?? '') : DEFAULT_STASH_TITLE,
                 customTitle: args.length === 1,
              }
           })()
         : undefined
   if (command !== 'gitspan' && command !== 'gitstash' && args.length !== 0) {
      throw new CommitMasterError(`${command} does not accept arguments.\n\n${USAGE}`)
   }

   const cwd = process.cwd()
   if (!(await ensureGitRepository(cwd, interruption))) return

   if (command === 'gitpaths') {
      interruption.throwIfInterrupted(0, 0)
      await runClipboardCommand(command, cwd, interruption.signal)
      return
   }

   if (command === 'gitstash' && stash) {
      await runStashCommand(cwd, stash.title, stash.customTitle, interruption.signal)
      return
   }

   const executionTime = new Date()
   const repository = await prepareRepository(cwd)
   const changes = await readChanges(repository)
   if (changes.length === 0) {
      console.log(repository.name)
      console.log('Nothing to commit. The working tree is clean.')
      return
   }
   interruption.throwIfInterrupted(0, changes.length)
   await validateCommitReadiness(repository, executionTime)

   let requests: CommitRequest[]
   let spanDetails: CommitspanOutputDetails | undefined
   if (span) {
      const schedule = createExpandableDateSchedule(
         span.duration,
         span.commitsPerDay,
         changes.length,
         executionTime
      )
      spanDetails = {
         requestedDuration: schedule.requestedDuration,
         effectiveDuration: schedule.effectiveDuration,
         commitsPerDay: span.commitsPerDay,
         startDate: schedule.startDate,
         endDate: schedule.endDate,
      }
      requests = changes.map((change, index) => ({
         change,
         message: createCommitMessage(change),
         timestamp: schedule.timestamps[index],
      }))
   } else {
      requests = changes.map((change) => ({ change, message: createCommitMessage(change) }))
   }

   const progress = new CommitProgressReporter(repository, requests.length, spanDetails)
   progress.start()
   try {
      const result = await commitChanges(repository, requests, progress, interruption)
      progress.complete()
      if (result.recoveredStagedEntries > 0) {
         console.log(
            `Recovered unexpected staged paths: ${result.recoveredStagedEntries}. Working-tree content was preserved.`
         )
      }
   } catch (error) {
      progress.fail(
         error instanceof CommitInterruptedError ||
            (interruption.isInterrupted() && !(error instanceof CommitOutcomeUnknownError))
      )
      throw error
   }
}

export const runCli = async (command: CommandName, args: readonly string[]): Promise<void> => {
   const interruption = new InterruptionController()
   interruption.install()
   try {
      await runCommand(command, args, interruption)
   } catch (caught) {
      const clipboardCommand = command === 'gitpaths' || command === 'gitbundle'
      const stashCommand = command === 'gitstash'
      const error = interruption.isInterrupted()
         ? clipboardCommand
            ? caught instanceof ClipboardInterruptedError
               ? caught
               : new ClipboardInterruptedError({ cause: caught })
            : stashCommand
              ? caught instanceof StashInterruptedError ||
                caught instanceof StashOutcomeUnknownError
                 ? caught
                 : new StashInterruptedError(false, { cause: caught })
              : !(caught instanceof CommitInterruptedError) &&
                !(caught instanceof CommitOutcomeUnknownError)
              ? new CommitInterruptedError(0, 0, { cause: caught, indexRestored: true })
              : caught
         : caught
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      process.exitCode =
         error instanceof CommitInterruptedError ||
         error instanceof ClipboardInterruptedError ||
         error instanceof StashInterruptedError
            ? 130
            : 1
   } finally {
      interruption.dispose()
   }
}

import { commitChanges } from './CommitMasterCommitService.js'
import { ensureGitRepository } from './CommitMasterBootstrap.js'
import {
   runClipboardCommand,
   type ClipboardCommandName,
} from './CommitMasterClipboardCommands.js'
import { createExpandableDateSchedule } from './CommitMasterDates.js'
import {
   ClipboardInterruptedError,
   CommitInterruptedError,
   CommitMasterError,
   CommitOutcomeUnknownError,
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

export type CommandName = 'commitspan' | 'autocommit' | ClipboardCommandName

export const USAGE = `Usage:
  commitspan <duration> <commits-per-day>
  autocommit
  gitpaths
  gitbundle

Examples:
  commitspan 10 5
  autocommit
  gitpaths
  gitbundle`

const positiveInteger = (value: string | undefined): number | undefined => {
   if (!value || !/^[1-9]\d*$/.test(value)) return undefined
   const parsed = Number(value)
   return Number.isSafeInteger(parsed) ? parsed : undefined
}

const parseCommitspanArguments = (
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

export const runCommand = async (
   command: CommandName,
   args: readonly string[],
   interruption: InterruptionController
): Promise<void> => {
   const span = command === 'commitspan' ? parseCommitspanArguments(args) : undefined
   if (command !== 'commitspan' && args.length !== 0) {
      throw new CommitMasterError(`${command} does not accept arguments.\n\n${USAGE}`)
   }

   const cwd = process.cwd()
   if (!(await ensureGitRepository(cwd, interruption))) return

   if (command === 'gitpaths' || command === 'gitbundle') {
      interruption.throwIfInterrupted(0, 0)
      await runClipboardCommand(command, cwd, interruption.signal)
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
         executionTime,
         repository.headTimestampSeconds
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
      const error = interruption.isInterrupted()
         ? clipboardCommand
            ? caught instanceof ClipboardInterruptedError
               ? caught
               : new ClipboardInterruptedError({ cause: caught })
            : !(caught instanceof CommitInterruptedError) &&
                !(caught instanceof CommitOutcomeUnknownError)
              ? new CommitInterruptedError(0, 0, { cause: caught, indexRestored: true })
              : caught
         : caught
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      process.exitCode =
         error instanceof CommitInterruptedError || error instanceof ClipboardInterruptedError
            ? 130
            : 1
   } finally {
      interruption.dispose()
   }
}

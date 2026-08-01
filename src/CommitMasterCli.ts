import { commitChanges } from './CommitMasterCommitService.js';
import { createExpandableDateSchedule } from './CommitMasterDates.js';
import { CommitInterruptedError, CommitMasterError } from './CommitMasterErrors.js';
import { InterruptionController } from './CommitMasterInterruption.js';
import { createCommitMessage } from './CommitMasterMessages.js';
import {
  printAutocommitSummary,
  printCommitspanSummary,
  printCompletion,
  type CommitspanOutputDetails,
} from './CommitMasterOutput.js';
import { CommitProgressReporter } from './CommitMasterProgress.js';
import { prepareRepository, readChanges, validateCommitReadiness } from './CommitMasterRepository.js';
import type { CommitRequest } from './CommitMasterTypes.js';

export type CommandName = 'commitspan' | 'autocommit';

export const USAGE = `Usage:
  commitspan <duration> <commits-per-day>
  autocommit

Examples:
  commitspan 10 5
  autocommit`;

const positiveInteger = (value: string | undefined): number | undefined => {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseCommitspanArguments = (args: readonly string[]): { duration: number; commitsPerDay: number } => {
  if (args.length !== 2) throw new CommitMasterError(`Invalid arguments.\n\n${USAGE}`);
  const duration = positiveInteger(args[0]);
  const commitsPerDay = positiveInteger(args[1]);
  if (duration === undefined || commitsPerDay === undefined) {
    throw new CommitMasterError(`Duration and commits-per-day must be whole integers greater than zero.\n\n${USAGE}`);
  }
  if (duration > Math.floor(Number.MAX_SAFE_INTEGER / commitsPerDay)) {
    throw new CommitMasterError(`The requested capacity is too large.\n\n${USAGE}`);
  }
  return { duration, commitsPerDay };
};

export const runCommand = async (
  command: CommandName,
  args: readonly string[],
  interruption: InterruptionController,
): Promise<void> => {
  const span = command === 'commitspan' ? parseCommitspanArguments(args) : undefined;
  if (command === 'autocommit' && args.length !== 0) {
    throw new CommitMasterError(`autocommit does not accept arguments.\n\n${USAGE}`);
  }

  const executionTime = new Date();
  const repository = await prepareRepository(process.cwd());
  const changes = await readChanges(repository);
  if (changes.length === 0) {
    console.log('Nothing to commit. The working tree is clean.');
    return;
  }
  interruption.throwIfInterrupted(0, changes.length);
  await validateCommitReadiness(repository, executionTime);

  let requests: CommitRequest[];
  let spanDetails: CommitspanOutputDetails | undefined;
  if (span) {
    const schedule = createExpandableDateSchedule(
      span.duration,
      span.commitsPerDay,
      changes.length,
      executionTime,
      repository.headTimestampSeconds,
    );
    spanDetails = {
      requestedDuration: schedule.requestedDuration,
      effectiveDuration: schedule.effectiveDuration,
      commitsPerDay: span.commitsPerDay,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
    };
    printCommitspanSummary(repository, changes.length, spanDetails);
    requests = changes.map((change, index) => ({
      change,
      message: createCommitMessage(change),
      timestamp: schedule.timestamps[index],
    }));
  } else {
    printAutocommitSummary(repository, changes.length);
    requests = changes.map((change) => ({ change, message: createCommitMessage(change) }));
  }

  const progress = new CommitProgressReporter(repository, requests.length);
  progress.start();
  try {
    const result = await commitChanges(repository, requests, progress, interruption);
    progress.complete();
    printCompletion(result, spanDetails);
  } catch (error) {
    progress.fail(error instanceof CommitInterruptedError || interruption.isInterrupted());
    throw error;
  }
};

export const runCli = async (command: CommandName, args: readonly string[]): Promise<void> => {
  const interruption = new InterruptionController();
  interruption.install();
  try {
    await runCommand(command, args, interruption);
  } catch (caught) {
    const error = interruption.isInterrupted() && !(caught instanceof CommitInterruptedError)
      ? new CommitInterruptedError(0, 0, { cause: caught, indexRestored: true })
      : caught;
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof CommitInterruptedError ? 130 : 1;
  } finally {
    interruption.dispose();
  }
};

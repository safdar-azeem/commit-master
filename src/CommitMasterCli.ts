import { commitChanges } from './CommitMasterCommitService.js';
import { createDateSchedule } from './CommitMasterDates.js';
import { CommitMasterError } from './CommitMasterErrors.js';
import { createCommitMessage } from './CommitMasterMessages.js';
import { printCommitspanSummary, printCompletion, printProgress } from './CommitMasterOutput.js';
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

export const runCommand = async (command: CommandName, args: readonly string[]): Promise<void> => {
  const span = command === 'commitspan' ? parseCommitspanArguments(args) : undefined;
  if (command === 'autocommit' && args.length !== 0) throw new CommitMasterError(`autocommit does not accept arguments.\n\n${USAGE}`);

  const executionTime = new Date();
  const repository = await prepareRepository(process.cwd());
  const changes = await readChanges(repository);
  if (changes.length === 0) {
    console.log('Nothing to commit. The working tree is clean.');
    return;
  }
  await validateCommitReadiness(repository, executionTime);

  let requests: CommitRequest[];
  if (span) {
    const schedule = createDateSchedule(
      span.duration,
      span.commitsPerDay,
      executionTime,
      repository.headTimestampSeconds,
    );
    printCommitspanSummary(
      repository,
      changes.length,
      schedule.startDate,
      schedule.endDate,
      span.commitsPerDay,
      schedule.timestamps.length,
    );
    if (changes.length > schedule.timestamps.length) {
      throw new CommitMasterError(
        `Commit span capacity is ${schedule.timestamps.length} commits, but ${changes.length} file changes were found.\nIncrease the duration or commits-per-day value. No commits were created.`,
      );
    }
    requests = changes.map((change, index) => ({
      change,
      message: createCommitMessage(change),
      timestamp: schedule.timestamps[index],
    }));
  } else {
    console.log(`Repository: ${repository.name}`);
    console.log(`Changed files: ${changes.length}`);
    requests = changes.map((change) => ({ change, message: createCommitMessage(change) }));
  }

  const result = await commitChanges(repository, requests, printProgress);
  printCompletion(result, command === 'commitspan');
};

export const runCli = async (command: CommandName, args: readonly string[]): Promise<void> => {
  try {
    await runCommand(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
};

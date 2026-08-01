import { formatCalendarDate } from './CommitMasterDates.js';
import type { CommitResult, RepositoryContext } from './CommitMasterTypes.js';

export interface CommitspanOutputDetails {
  requestedDuration: number;
  effectiveDuration: number;
  commitsPerDay: number;
  startDate: Date;
  endDate: Date;
}

export const printCommitspanSummary = (
  repository: RepositoryContext,
  commits: number,
  details: CommitspanOutputDetails,
): void => {
  console.log('Commit Master');
  console.log(`Repository: ${repository.name}`);
  console.log(`Commits to create: ${commits}`);
  console.log(`Requested duration: ${details.requestedDuration} days`);
  console.log(`Effective duration: ${details.effectiveDuration} days`);
  console.log(`Date range: ${formatCalendarDate(details.startDate)} to ${formatCalendarDate(details.endDate)}`);
  console.log(`Commits per day: ${details.commitsPerDay}`);
};

export const printAutocommitSummary = (repository: RepositoryContext, commits: number): void => {
  console.log('Commit Master');
  console.log(`Repository: ${repository.name}`);
  console.log(`Commits to create: ${commits}`);
};

export const printCompletion = (result: CommitResult, details?: CommitspanOutputDetails): void => {
  console.log('Completed successfully.');
  console.log(`Created commits: ${result.created}`);
  if (result.recoveredStagedEntries > 0) {
    console.log(
      `Recovered unexpected staged paths: ${result.recoveredStagedEntries} (working-tree content was preserved).`,
    );
  }
  if (details && result.firstTimestamp && result.lastTimestamp) {
    console.log(`Requested duration: ${details.requestedDuration} days`);
    console.log(`Effective duration: ${details.effectiveDuration} days`);
    console.log(`Maximum commits per day: ${details.commitsPerDay}`);
    console.log(`First commit date: ${formatCalendarDate(result.firstTimestamp)}`);
    console.log(`Last commit date: ${formatCalendarDate(result.lastTimestamp)}`);
  }
};

import { formatCalendarDate, formatProgressTimestamp } from './CommitMasterDates.js';
import type { CommitRequest, CommitResult, RepositoryContext } from './CommitMasterTypes.js';

export const printCommitspanSummary = (
  repository: RepositoryContext,
  changedFiles: number,
  startDate: Date,
  endDate: Date,
  commitsPerDay: number,
  capacity: number,
): void => {
  console.log(`Repository: ${repository.name}`);
  console.log(`Changed files: ${changedFiles}`);
  console.log(`Date range: ${formatCalendarDate(startDate)} to ${formatCalendarDate(endDate)}`);
  console.log(`Maximum commits per day: ${commitsPerDay}`);
  console.log(`Available capacity: ${capacity}`);
};

export const printProgress = (completed: number, total: number, request: CommitRequest): void => {
  const timestamp = request.timestamp ? `${formatProgressTimestamp(request.timestamp)} ` : '';
  console.log(`[${completed}/${total}] ${timestamp}${request.message}`);
};

export const printCompletion = (result: CommitResult, historical: boolean): void => {
  console.log('Completed successfully.');
  console.log(`Created commits: ${result.created}`);
  if (historical && result.firstTimestamp && result.lastTimestamp) {
    console.log(`First commit date: ${formatCalendarDate(result.firstTimestamp)}`);
    console.log(`Last commit date: ${formatCalendarDate(result.lastTimestamp)}`);
  }
};

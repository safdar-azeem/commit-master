import { formatCalendarDate } from './CommitMasterDates.js'
import type { RepositoryContext } from './CommitMasterTypes.js'

export interface CommitspanOutputDetails {
   requestedDuration: number
   effectiveDuration: number
   commitsPerDay: number
   startDate: Date
   endDate: Date
}

export const createProgressHeader = (
   repository: RepositoryContext,
   commits: number,
   details?: CommitspanOutputDetails
): string[] => {
   if (!details) return []
   return [
      repository.name,
      `${commits} commits · ${details.effectiveDuration} days · ${details.commitsPerDay}/day`,
      `${formatCalendarDate(details.startDate)} → ${formatCalendarDate(details.endDate)}`,
   ]
}

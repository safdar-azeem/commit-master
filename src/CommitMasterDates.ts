import { CommitMasterError } from './CommitMasterErrors.js';

export interface DateSchedule {
  requestedDuration: number;
  effectiveDuration: number;
  startDate: Date;
  endDate: Date;
  timestamps: Date[];
}

const startOfLocalDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const withLocalTime = (day: Date, hours: number, minutes: number, seconds: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, seconds, 0);

const createDaySlots = (day: Date, maximum: number, now: Date, minimumExclusive?: Date): Date[] => {
  const isToday = startOfLocalDay(day).getTime() === startOfLocalDay(now).getTime();
  let lower = withLocalTime(day, 9, 0, 0);
  let upper = isToday ? now : withLocalTime(day, 17, 0, 0);

  if (isToday && upper.getTime() < lower.getTime()) lower = startOfLocalDay(day);
  if (minimumExclusive && minimumExclusive.getTime() >= lower.getTime()) {
    lower = new Date(minimumExclusive.getTime() + 1000);
  }
  if (!isToday && lower.getTime() > upper.getTime()) upper = withLocalTime(day, 23, 59, 59);
  if (lower.getTime() > upper.getTime()) return [];

  const availableSeconds = Math.floor((upper.getTime() - lower.getTime()) / 1000) + 1;
  const count = Math.min(maximum, availableSeconds);
  if (count === 1) return [new Date(lower)];

  const spanSeconds = Math.floor((upper.getTime() - lower.getTime()) / 1000);
  return Array.from({ length: count }, (_, index) => {
    const offsetSeconds = Math.floor((spanSeconds * index) / (count - 1));
    return new Date(lower.getTime() + offsetSeconds * 1000);
  });
};

const buildSchedule = (
  duration: number,
  commitsPerDay: number,
  executionTime: Date,
  headTimestampSeconds?: number,
): Omit<DateSchedule, 'requestedDuration' | 'effectiveDuration'> => {
  const endDate = startOfLocalDay(executionTime);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - duration + 1);
  const minimum = headTimestampSeconds === undefined ? undefined : new Date(headTimestampSeconds * 1000);
  const timestamps: Date[] = [];

  for (let offset = 0; offset < duration; offset += 1) {
    const day = new Date(startDate);
    day.setDate(startDate.getDate() + offset);
    timestamps.push(...createDaySlots(day, commitsPerDay, executionTime, minimum));
  }
  return { startDate, endDate, timestamps };
};

export const createExpandableDateSchedule = (
  requestedDuration: number,
  commitsPerDay: number,
  requiredCommits: number,
  executionTime: Date,
  headTimestampSeconds?: number,
): DateSchedule => {
  let effectiveDuration = Math.max(requestedDuration, Math.ceil(requiredCommits / commitsPerDay));
  let previousCapacity = -1;

  while (Number.isSafeInteger(effectiveDuration)) {
    const schedule = buildSchedule(effectiveDuration, commitsPerDay, executionTime, headTimestampSeconds);
    if (schedule.timestamps.length >= requiredCommits) {
      return {
        requestedDuration,
        effectiveDuration,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        timestamps: schedule.timestamps.slice(0, requiredCommits),
      };
    }
    if (schedule.timestamps.length === previousCapacity) {
      throw new CommitMasterError(
        `The existing HEAD timestamp leaves only ${schedule.timestamps.length} chronological commit slots through the current time. ` +
          `${requiredCommits} commits cannot be created without exceeding ${commitsPerDay} commits per day, using future timestamps, or dating a new commit before HEAD.`,
      );
    }
    previousCapacity = schedule.timestamps.length;
    effectiveDuration += 1;
  }
  throw new CommitMasterError('The effective commit duration exceeds the supported integer range.');
};

export const toGitDate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) throw new CommitMasterError('Cannot format an invalid commit timestamp.');
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
};

export const formatCalendarDate = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);

export const formatProgressDate = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

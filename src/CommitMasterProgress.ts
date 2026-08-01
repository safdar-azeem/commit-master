import * as readline from 'node:readline';
import { formatProgressDate } from './CommitMasterDates.js';
import type { CommitProgressCallbacks, CommitRequest, RepositoryContext } from './CommitMasterTypes.js';

type ProgressState = 'Running' | 'Completed' | 'Failed' | 'Interrupted';

const BAR_WIDTH = 30;

const percentage = (completed: number, total: number): number =>
  total === 0 ? 100 : Math.min(100, Math.round((completed / total) * 100));

const progressBar = (completed: number, total: number): string => {
  const filled = total === 0 ? BAR_WIDTH : Math.floor((completed / total) * BAR_WIDTH);
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`;
};

export class CommitProgressReporter implements CommitProgressCallbacks {
  private readonly interactive: boolean;
  private completed = 0;
  private current = 'Waiting to start';
  private currentDate = '-';
  private state: ProgressState = 'Running';
  private renderedLines = 0;
  private lastFallbackBucket = -1;

  public constructor(
    private readonly repository: RepositoryContext,
    private readonly total: number,
  ) {
    this.interactive = Boolean(process.stdout.isTTY && !process.env.CI && process.env.TERM !== 'dumb');
  }

  public start(): void {
    this.render(true);
  }

  public onStart(request: CommitRequest, completed: number): void {
    this.completed = completed;
    this.current = request.message;
    this.currentDate = formatProgressDate(request.timestamp ?? new Date());
    this.render(false);
  }

  public onCommit(request: CommitRequest, completed: number): void {
    this.completed = completed;
    this.current = request.message;
    this.currentDate = formatProgressDate(request.timestamp ?? new Date());
    if (!this.interactive && completed === this.total) return;
    this.render(false);
  }

  public complete(): void {
    this.completed = this.total;
    this.state = 'Completed';
    this.render(true);
  }

  public fail(interrupted: boolean): void {
    this.state = interrupted ? 'Interrupted' : 'Failed';
    this.render(true);
  }

  private lines(): string[] {
    const percent = percentage(this.completed, this.total);
    return [
      'Commit Master',
      `Repository: ${this.repository.name}`,
      `Commits: ${this.completed}/${this.total}`,
      `Progress: ${progressBar(this.completed, this.total)} ${percent}%`,
      `Date: ${this.currentDate}`,
      `Current: ${this.current}`,
      `Status: ${this.state}`,
    ];
  }

  private render(forceFallback: boolean): void {
    if (this.interactive) {
      if (this.renderedLines > 0) readline.moveCursor(process.stdout, 0, -this.renderedLines);
      for (const line of this.lines()) {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`${line}\n`);
      }
      this.renderedLines = this.lines().length;
      return;
    }

    const percent = percentage(this.completed, this.total);
    const bucket = Math.floor(percent / 10);
    if (!forceFallback && bucket <= this.lastFallbackBucket) return;
    this.lastFallbackBucket = bucket;
    const suffix = this.current === 'Waiting to start' ? '' : ` - ${this.current}`;
    console.log(`Progress: ${this.completed}/${this.total} (${percent}%) - ${this.state}${suffix}`);
  }
}

import * as readline from 'node:readline'
import { createProgressHeader, type CommitspanOutputDetails } from './CommitMasterOutput.js'
import type {
   CommitProgressCallbacks,
   CommitRequest,
   RepositoryContext,
} from './CommitMasterTypes.js'

type ProgressState = 'Running' | 'Completed' | 'Failed' | 'Interrupted'

const BAR_WIDTH = 30

export const progressPercentage = (completed: number, total: number): number =>
   total === 0 ? 100 : Math.min(100, Math.round((completed / total) * 100))

export const createProgressBar = (completed: number, total: number): string => {
   const filled = total === 0 ? BAR_WIDTH : Math.floor((completed / total) * BAR_WIDTH)
   return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`
}

export const createProgressSection = (
   completed: number,
   total: number,
   state: ProgressState,
   current: string
): string[] => {
   const lines = [
      `Progress: ${createProgressBar(completed, total)} ${progressPercentage(completed, total)}%`,
   ]
   if (current) {
      const label =
         state === 'Failed' ? 'Failed at' : state === 'Interrupted' ? 'Interrupted at' : 'Current'
      lines.push(`${label}: ${current}`)
   }
   lines.push(`Status: ${state}`)
   return lines
}

export class CommitProgressReporter implements CommitProgressCallbacks {
   private readonly interactive: boolean
   private completed = 0
   private current = ''
   private state: ProgressState = 'Running'
   private renderedLines = 0
   private lastFallbackBucket = -1

   public constructor(
      private readonly repository: RepositoryContext,
      private readonly total: number,
      private readonly details?: CommitspanOutputDetails
   ) {
      this.interactive = Boolean(
         repository.inPlaceProgressSafe &&
         process.stdout.isTTY &&
         process.stderr.isTTY &&
         !process.env.CI &&
         process.env.TERM !== 'dumb'
      )
   }

   public start(): void {
      const header = createProgressHeader(this.repository, this.total, this.details)
      if (header.length > 0) {
         console.log(header.join('\n'))
         console.log('')
      }
      this.render(true)
   }

   public onStart(request: CommitRequest, completed: number): void {
      this.completed = completed
      this.current = request.message
      this.render(false)
   }

   public onCommit(request: CommitRequest, completed: number): void {
      this.completed = completed
      this.current = request.message
      if (!this.interactive && completed === this.total) return
      this.render(false)
   }

   public complete(): void {
      this.completed = this.total
      this.current = ''
      this.state = 'Completed'
      this.render(true)
   }

   public fail(interrupted: boolean): void {
      this.state = interrupted ? 'Interrupted' : 'Failed'
      this.render(true)
   }

   private sectionLines(): string[] {
      return createProgressSection(this.completed, this.total, this.state, this.current)
   }

   private render(forceFallback: boolean): void {
      if (this.interactive) {
         if (this.renderedLines > 0) readline.moveCursor(process.stdout, 0, -this.renderedLines)
         const lines = this.sectionLines()
         const lineCount = Math.max(this.renderedLines, lines.length)
         for (let index = 0; index < lineCount; index += 1) {
            readline.cursorTo(process.stdout, 0)
            readline.clearLine(process.stdout, 0)
            if (index < lines.length) process.stdout.write(lines[index] ?? '')
            process.stdout.write('\n')
         }
         if (lineCount > lines.length)
            readline.moveCursor(process.stdout, 0, lines.length - lineCount)
         this.renderedLines = lines.length
         return
      }

      const percent = progressPercentage(this.completed, this.total)
      const bucket = Math.floor(percent / 10)
      if (!forceFallback && bucket <= this.lastFallbackBucket) return
      this.lastFallbackBucket = bucket
      const current = this.current ? ` · ${this.current}` : ''
      console.log(
         `Progress: ${createProgressBar(this.completed, this.total)} ${percent}% · ${this.state}${current}`
      )
   }
}

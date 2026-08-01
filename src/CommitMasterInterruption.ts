import { CommitInterruptedError } from './CommitMasterErrors.js'

export class InterruptionController {
   private interrupted = false
   private installed = false
   private readonly abortController = new AbortController()

   private readonly handleSignal = (): void => {
      this.interrupted = true
      this.abortController.abort()
   }

   public get signal(): AbortSignal {
      return this.abortController.signal
   }

   public install(): void {
      if (this.installed) return
      process.on('SIGINT', this.handleSignal)
      this.installed = true
   }

   public dispose(): void {
      if (!this.installed) return
      process.off('SIGINT', this.handleSignal)
      this.installed = false
   }

   public isInterrupted(): boolean {
      return this.interrupted
   }

   public throwIfInterrupted(completed: number, total: number): void {
      if (this.interrupted) throw new CommitInterruptedError(completed, total)
   }
}

import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { CommitInterruptedError, CommitMasterError } from './CommitMasterErrors.js'
import type { InterruptionController } from './CommitMasterInterruption.js'

export type ConfirmationAnswer = 'yes' | 'no' | 'invalid'

export interface PromptStreams {
   input: Readable & { isTTY?: boolean }
   output: Writable & { isTTY?: boolean }
   environment: NodeJS.ProcessEnv
}

export const parseConfirmationAnswer = (answer: string): ConfirmationAnswer => {
   const normalized = answer.trim().toLowerCase()
   if (normalized === '' || normalized === 'y' || normalized === 'yes') return 'yes'
   if (normalized === 'n' || normalized === 'no') return 'no'
   return 'invalid'
}

const defaultStreams = (): PromptStreams => ({
   input: process.stdin,
   output: process.stdout,
   environment: process.env,
})

export const confirmGitInitialization = async (
   interruption: InterruptionController,
   streams: PromptStreams = defaultStreams()
): Promise<boolean> => {
   if (!streams.input.isTTY || !streams.output.isTTY || streams.environment.CI) {
      throw new CommitMasterError(
         'Git is not initialized in this project.\nInitialize Git before running Commit Master.'
      )
   }

   streams.output.write('Git is not initialized in this project.\n')
   const prompt = createInterface({ input: streams.input, output: streams.output })
   try {
      while (true) {
         let answer: string
         try {
            answer = await prompt.question('Initialize it now? (Y/n) ', {
               signal: interruption.signal,
            })
         } catch (error) {
            if (interruption.isInterrupted()) {
               throw new CommitInterruptedError(0, 0, { cause: error, indexRestored: true })
            }
            return false
         }
         const confirmation = parseConfirmationAnswer(answer)
         if (confirmation === 'yes') return true
         if (confirmation === 'no') return false
         streams.output.write('Please answer yes or no.\n')
      }
   } finally {
      prompt.close()
   }
}

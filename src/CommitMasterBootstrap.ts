import type { InterruptionController } from './CommitMasterInterruption.js'
import { confirmGitInitialization } from './CommitMasterPrompt.js'
import { initializeRepository, resolveRepositoryRoot } from './CommitMasterRepository.js'

export type InitializationConfirmation = (interruption: InterruptionController) => Promise<boolean>

export const ensureGitRepository = async (
   cwd: string,
   interruption: InterruptionController,
   confirm: InitializationConfirmation = confirmGitInitialization
): Promise<boolean> => {
   const existingRoot = await resolveRepositoryRoot(cwd)
   if (existingRoot) return true

   const confirmed = await confirm(interruption)
   if (!confirmed) {
      console.log('Git initialization cancelled.')
      return false
   }

   await initializeRepository(cwd)
   console.log('\nGit initialized.')
   return true
}

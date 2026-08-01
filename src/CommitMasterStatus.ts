import { CommitMasterError } from './CommitMasterErrors.js'
import type { ChangeKind, FileChange } from './CommitMasterTypes.js'

const STATUS_PRIORITY: Record<ChangeKind, number> = {
   deleted: 0,
   modified: 1,
   renamed: 2,
   new: 3,
}

const comparePaths = (left: string, right: string): number =>
   left < right ? -1 : left > right ? 1 : 0

const classify = (status: string): ChangeKind => {
   const index = status[0] ?? ' '
   const worktree = status[1] ?? ' '
   if (status === '??' || index === 'A') return 'new'
   if (index === 'R' || worktree === 'R' || index === 'C' || worktree === 'C') return 'renamed'
   if (index === 'D' || worktree === 'D') return 'deleted'
   return 'modified'
}

const isUnmerged = (status: string): boolean => {
   const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
   return conflicts.has(status)
}

export const parseWorkingTreeStatus = (output: Buffer): FileChange[] => {
   const fields = output.toString('utf8').split('\0')
   const changes: FileChange[] = []

   for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index]
      if (!entry) continue
      if (entry.length < 4 || entry[2] !== ' ') {
         throw new CommitMasterError('Git returned an unsupported working-tree status record.')
      }

      const status = entry.slice(0, 2)
      if (isUnmerged(status)) {
         throw new CommitMasterError(
            'The repository contains unresolved conflicts. Resolve them before running Commit Master.'
         )
      }

      const path = entry.slice(3)
      const kind = classify(status)
      if (kind === 'renamed') {
         const previousPath = fields[index + 1]
         if (!previousPath) {
            throw new CommitMasterError(`Git returned an incomplete rename record for "${path}".`)
         }
         changes.push({ kind, path, previousPath })
         index += 1
      } else {
         changes.push({ kind, path })
      }
   }

   return changes.sort((left, right) => {
      const byKind = STATUS_PRIORITY[left.kind] - STATUS_PRIORITY[right.kind]
      return (
         byKind ||
         comparePaths(left.path, right.path) ||
         comparePaths(left.previousPath ?? '', right.previousPath ?? '')
      )
   })
}

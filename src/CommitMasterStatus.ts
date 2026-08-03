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

   return sortFileChanges(changes)
}

export const sortFileChanges = (changes: readonly FileChange[]): FileChange[] =>
   [...changes].sort((left, right) => {
      const byKind = STATUS_PRIORITY[left.kind] - STATUS_PRIORITY[right.kind]
      return (
         byKind ||
         comparePaths(left.path, right.path) ||
         comparePaths(left.previousPath ?? '', right.previousPath ?? '')
      )
   })

/** Merge delete + untracked pairs that share identical blob content into renames. */
export const mergeContentIdenticalRenames = (
   changes: readonly FileChange[],
   deletedBlobIds: ReadonlyMap<string, string>,
   createdBlobIds: ReadonlyMap<string, string>
): FileChange[] => {
   const deleted = changes.filter((change) => change.kind === 'deleted')
   const created = changes.filter((change) => change.kind === 'new')
   if (deleted.length === 0 || created.length === 0) return sortFileChanges(changes)

   const others = changes.filter((change) => change.kind !== 'deleted' && change.kind !== 'new')
   const deletedByOid = new Map<string, FileChange[]>()
   const createdByOid = new Map<string, FileChange[]>()
   const unpairedDeleted: FileChange[] = []
   const unpairedCreated: FileChange[] = []

   for (const change of deleted) {
      const oid = deletedBlobIds.get(change.path)
      if (!oid) {
         unpairedDeleted.push(change)
         continue
      }
      const queue = deletedByOid.get(oid)
      if (queue) queue.push(change)
      else deletedByOid.set(oid, [change])
   }
   for (const change of created) {
      const oid = createdBlobIds.get(change.path)
      if (!oid) {
         unpairedCreated.push(change)
         continue
      }
      const queue = createdByOid.get(oid)
      if (queue) queue.push(change)
      else createdByOid.set(oid, [change])
   }

   const renames: FileChange[] = []
   for (const [oid, deletedQueue] of deletedByOid) {
      deletedQueue.sort((left, right) => comparePaths(left.path, right.path))
      const createdQueue = createdByOid.get(oid) ?? []
      createdQueue.sort((left, right) => comparePaths(left.path, right.path))
      const pairCount = Math.min(deletedQueue.length, createdQueue.length)
      for (let index = 0; index < pairCount; index += 1) {
         const previous = deletedQueue[index]
         const next = createdQueue[index]
         if (!previous || !next) continue
         renames.push({ kind: 'renamed', path: next.path, previousPath: previous.path })
      }
      unpairedDeleted.push(...deletedQueue.slice(pairCount))
      unpairedCreated.push(...createdQueue.slice(pairCount))
      createdByOid.delete(oid)
   }
   for (const createdQueue of createdByOid.values()) unpairedCreated.push(...createdQueue)

   return sortFileChanges([...others, ...unpairedDeleted, ...unpairedCreated, ...renames])
}

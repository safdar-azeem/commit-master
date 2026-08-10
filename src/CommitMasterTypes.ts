export type ChangeKind = 'deleted' | 'modified' | 'renamed' | 'new'

export interface FileChange {
   kind: ChangeKind
   path: string
   previousPath?: string
}

export interface RepositoryContext {
   root: string
   name: string
   headTimestampSeconds?: number
   inPlaceProgressSafe: boolean
}

export interface CommitRequest {
   change: FileChange
   message: string
   timestamp?: Date
}

export interface CommitResult {
   created: number
   firstTimestamp?: Date
   lastTimestamp?: Date
   recoveredStagedEntries: number
}

export interface CommitProgressCallbacks {
   onStart(request: CommitRequest, completed: number, total: number): void
   onCommit(request: CommitRequest, completed: number, total: number): void
}

export interface SavedWorkspace {
   name: string
   repositories: string[]
}

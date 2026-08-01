export class CommitMasterError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommitMasterError';
  }
}

export class GitUnavailableError extends CommitMasterError {
  public constructor(options?: ErrorOptions) {
    super('Git is not available. Install Git and ensure the "git" executable is on your PATH.', options);
    this.name = 'GitUnavailableError';
  }
}

export class GitCommandError extends CommitMasterError {
  public readonly category: string;
  public readonly exitCode: number | null;
  public readonly stderr: string;

  public constructor(category: string, exitCode: number | null, stderr: string) {
    const detail = stderr.trim() || 'Git did not provide additional error output.';
    super(`${category} failed. Git reported: ${detail}`);
    this.name = 'GitCommandError';
    this.category = category;
    this.exitCode = exitCode;
    this.stderr = stderr.trim();
  }
}

export class FileCommitError extends CommitMasterError {
  public readonly file: string;
  public readonly completed: number;

  public constructor(
    file: string,
    completed: number,
    total: number,
    cause: unknown,
    indexRestored: boolean,
  ) {
    const detail = cause instanceof GitCommandError
      ? `Git reported: ${cause.stderr || cause.message}`
      : cause instanceof Error
        ? cause.message
        : String(cause);
    const recovery = indexRestored
      ? '\nThe staging area was restored and working-tree changes were preserved.'
      : '\nThe staging area could not be fully restored. Review the Git index before retrying.';
    super(
      `${detail}\nCreated commits: ${completed}\nRemaining changes: ${Math.max(0, total - completed)}${recovery}`,
      { cause },
    );
    this.name = 'FileCommitError';
    this.file = file;
    this.completed = completed;
  }
}

export class CommitOutcomeUnknownError extends CommitMasterError {
  public readonly file: string;

  public constructor(file: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Commit completion for "${file}" could not be verified safely.\n${detail}\n` +
        'Inspect HEAD and the staging area before retrying. Commit Master did not automatically reset this ambiguous state.',
      { cause },
    );
    this.name = 'CommitOutcomeUnknownError';
    this.file = file;
  }
}

export class CommitInterruptedError extends CommitMasterError {
  public readonly completed: number;
  public readonly total: number;

  public constructor(
    completed: number,
    total: number,
    options?: ErrorOptions & { indexRestored?: boolean },
  ) {
    const remaining = Math.max(0, total - completed);
    const recovery = options?.indexRestored === false
      ? '\nThe staging area could not be fully restored. Review the Git index before retrying.'
      : '\nThe staging area is clean and working-tree changes were preserved.';
    super(`Created commits: ${completed}\nRemaining changes: ${remaining}${recovery}`, options);
    this.name = 'CommitInterruptedError';
    this.completed = completed;
    this.total = total;
  }
}

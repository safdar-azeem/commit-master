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

  public constructor(file: string, completed: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Unable to commit "${file}".\n${detail}\nCreated ${completed} commit${completed === 1 ? '' : 's'} before the failure.`, {
      cause,
    });
    this.name = 'FileCommitError';
    this.file = file;
    this.completed = completed;
  }
}

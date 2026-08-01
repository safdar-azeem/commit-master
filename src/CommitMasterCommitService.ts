import { CommitMasterError, FileCommitError } from './CommitMasterErrors.js';
import { runGit } from './CommitMasterGitRunner.js';
import { displayPath } from './CommitMasterMessages.js';
import { toGitDate } from './CommitMasterDates.js';
import type { CommitRequest, CommitResult, FileChange, RepositoryContext } from './CommitMasterTypes.js';

const affectedPaths = (change: FileChange): string[] =>
  change.kind === 'renamed' && change.previousPath ? [change.previousPath, change.path] : [change.path];

const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const verifyIsolatedIndex = async (repository: RepositoryContext, change: FileChange): Promise<void> => {
  const staged = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], {
    cwd: repository.root,
    category: `Staging verification for "${displayPath(change)}"`,
  });
  const actual = staged.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const expected = affectedPaths(change);
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
    throw new CommitMasterError(
      `The staging area did not contain only the intended change for "${displayPath(change)}". Processing stopped without creating that commit.`,
    );
  }
};

const stageChange = async (repository: RepositoryContext, change: FileChange): Promise<void> => {
  await runGit(['add', '-A', '--', ...affectedPaths(change)], {
    cwd: repository.root,
    category: `Staging "${displayPath(change)}"`,
  });
  await verifyIsolatedIndex(repository, change);
};

export const commitChanges = async (
  repository: RepositoryContext,
  requests: readonly CommitRequest[],
  onProgress: (completed: number, total: number, request: CommitRequest) => void,
): Promise<CommitResult> => {
  let created = 0;
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  for (const request of requests) {
    try {
      await stageChange(repository, request.change);
      const gitDate = request.timestamp ? toGitDate(request.timestamp) : undefined;
      await runGit(['commit', '-m', request.message, '--', ...affectedPaths(request.change)], {
        cwd: repository.root,
        category: `Committing "${displayPath(request.change)}"`,
        env: gitDate ? { GIT_AUTHOR_DATE: gitDate, GIT_COMMITTER_DATE: gitDate } : undefined,
      });
      created += 1;
      if (request.timestamp) {
        firstTimestamp ??= request.timestamp;
        lastTimestamp = request.timestamp;
      }
      onProgress(created, requests.length, request);
    } catch (error) {
      throw new FileCommitError(displayPath(request.change), created, error);
    }
  }
  return { created, firstTimestamp, lastTimestamp };
};

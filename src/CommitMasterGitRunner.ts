import { spawn } from 'node:child_process';
import { GitCommandError, GitUnavailableError } from './CommitMasterErrors.js';

export interface GitRunOptions {
  cwd: string;
  category: string;
  env?: NodeJS.ProcessEnv;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

const createGitEnvironment = (overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  const repositoryOverrides = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_DATE',
  ] as const;
  for (const variable of repositoryOverrides) delete environment[variable];
  return { ...environment, ...overrides };
};

export const runGit = (args: readonly string[], options: GitRunOptions): Promise<GitRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: createGitEnvironment(options.env),
      shell: false,
      windowsHide: true,
      signal: options.signal,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new GitUnavailableError({ cause: error }));
        return;
      }
      reject(new GitCommandError(options.category, null, error.message));
    });
    child.once('close', (exitCode) => {
      const code = exitCode ?? -1;
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code,
      };
      const accepted = options.acceptedExitCodes ?? [0];
      if (accepted.includes(code)) {
        resolve(result);
        return;
      }
      reject(new GitCommandError(options.category, exitCode, result.stderr.toString('utf8')));
    });
  });

export const gitText = async (args: readonly string[], options: GitRunOptions): Promise<string> => {
  const result = await runGit(args, options);
  return result.stdout.toString('utf8').trim();
};

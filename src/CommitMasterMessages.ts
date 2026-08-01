import type { FileChange } from './CommitMasterTypes.js';

const readablePath = (filePath: string): string =>
  filePath
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');

export const createCommitMessage = (change: FileChange): string => {
  const current = readablePath(change.path);
  switch (change.kind) {
    case 'new':
      return `Add ${current}`;
    case 'modified':
      return `Update ${current}`;
    case 'deleted':
      return `Delete ${current}`;
    case 'renamed':
      return `Rename ${readablePath(change.previousPath ?? '')} to ${current}`;
  }
};

export const displayPath = (change: FileChange): string =>
  change.kind === 'renamed' ? `${readablePath(change.previousPath ?? '')} to ${readablePath(change.path)}` : readablePath(change.path);

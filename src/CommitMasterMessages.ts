import type { FileChange } from './CommitMasterTypes.js';

const readablePath = (filePath: string): string =>
  filePath.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');

const fileName = (filePath: string): string => {
  const parts = readablePath(filePath).split('/').filter(Boolean);
  return parts.at(-1) ?? '';
};

export const createCommitMessage = (change: FileChange): string => {
  const current = fileName(change.path);
  switch (change.kind) {
    case 'new':
      return `Add ${current}`;
    case 'modified':
      return `Update ${current}`;
    case 'deleted':
      return `Delete ${current}`;
    case 'renamed':
      return `Rename ${fileName(change.previousPath ?? '')} to ${current}`;
  }
};

export const displayPath = (change: FileChange): string =>
  change.kind === 'renamed' ? `${readablePath(change.previousPath ?? '')} to ${readablePath(change.path)}` : readablePath(change.path);

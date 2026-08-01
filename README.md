# Commit Master

Commit Master is a global TypeScript CLI that creates one Git commit per logical file change. One installation provides exactly two commands:

- `commitspan` distributes current changes across a historical calendar range.
- `autocommit` commits current changes immediately.

Both commands resolve the Git repository from the terminal's current directory, including when run from a nested directory. They never scan sibling repositories.

## Requirements

- Node.js 18.18 or newer
- Git available on `PATH`
- A Git author and committer name and email

No package manager is required at runtime. Commit Master supports macOS, Linux, and Windows.

## Global installation

npm:

```bash
npm install --global commit-master
```

Yarn:

```bash
yarn global add commit-master
```

pnpm:

```bash
pnpm add --global commit-master
```

After installation:

```bash
commitspan 10 5
autocommit
```

The package's `prepack` lifecycle invokes the local TypeScript compiler directly. Packaging and publication do not require Yarn.

## `commitspan`

```bash
commitspan <duration> <commits-per-day>
```

`duration` is the requested number of inclusive calendar days ending on the current local date. `commits-per-day` is a strict positive limit for each date.

Commit Master automatically calculates:

```text
effectiveDuration = max(requestedDuration, ceil(changes / commitsPerDay))
```

If more days are required, the start date moves backward automatically. The end date remains the current date, the per-day limit is never exceeded, and the user does not need to calculate new arguments or rerun the command.

For example, `commitspan 10 5` with 58 logical changes uses 12 effective days:

```text
Day 1 through Day 11: 5 commits per day
Day 12: 3 commits
```

The summary reports both values:

```text
Requested duration: 10 days
Effective duration: 12 days
Commits per day: 5
Commits to create: 58
```

Changes are ordered deterministically:

1. Deleted files
2. Modified files
3. Renamed files
4. New files

Paths are sorted inside each group. A rename is one logical change and one commit.

Messages follow these patterns:

```text
Add src/users.ts
Update package.json
Delete src/legacy-config.ts
Rename src/old-name.ts to src/new-name.ts
```

Commit times increase deterministically within each local day. Current-day timestamps never exceed the command's start time, and each timestamp receives the correct local UTC offset for that date. Both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` are assigned to newly created historical commits.

Existing commits are never amended, rebased, or rewritten. New timestamps must remain later than `HEAD`. The scheduler expands while earlier dates add usable chronological slots. If `HEAD` is so recent that the strict daily limit leaves too few post-`HEAD` timestamps through the present, no backward expansion can solve that constraint; Commit Master stops instead of creating future-dated commits or commits timestamped before their parent.

## `autocommit`

```bash
autocommit
```

`autocommit` snapshots eligible changes, commits each logical change separately with the real current time, and exits. It is not a watcher or daemon.

## Progress display

Interactive terminals receive one continuously updated display:

```text
Commit Master
Repository: network-logger
Commits: 34/58
Progress: [█████████████████░░░░░░░░░░░░░] 59%
Date: 2026-07-27
Current: Update src/modules/network.ts
Status: Running
```

The completed count advances only after Git confirms a successful commit. The final 100% display remains visible before the compact completion summary.

CI, redirected output, `TERM=dumb`, and other non-interactive environments do not receive cursor-control sequences. They receive throttled progress milestones instead of one log entry per file.

Commit Master does not hide the terminal cursor, so interruption and failure cannot leave it hidden.

## Failure and interruption recovery

Commit Master requires a clean index before it starts. That clean boundary lets it safely recover staging introduced by the current transaction.

If staging or committing fails because of a hook, signing, Git failure, or Ctrl+C:

- successful earlier commits remain in history;
- the failed transaction's index changes are removed;
- hook-generated staged entries from that transaction are removed;
- all working-tree content is preserved;
- failed and unprocessed changes remain available;
- no successful commit is reset;
- the repository is immediately safe to retry.

Ctrl+C sets an interruption request. Commit Master finishes or aborts the current Git boundary, restores a clean index for an uncommitted file, renders an `Interrupted` progress state, reports completed and remaining commits, and exits with status 130. It never starts the next file after interruption is requested.

If a hook stages additional files but the intended commit succeeds, those unexpected index entries are unstaged while their working-tree content is retained.

## Eligible changes and path safety

Both commands support:

- untracked, non-ignored files;
- modified tracked files;
- deleted tracked files;
- Git-detected renames;
- spaces, Unicode characters, hidden paths, nested paths, and names beginning with `-`;
- symbolic links according to normal Git behavior.

Ignored untracked files remain ignored. Git output is NUL-delimited, process output is fully buffered, commands use argument arrays rather than shell strings, and paths follow `--` where applicable.

Before each commit, the index is verified to contain only the intended path or rename pair. The commit is also restricted by Git pathspecs. Normal Git hooks and signing configuration remain enabled.

## Repository safety

Commit Master stops before mutation when it detects:

- a merge, rebase, cherry-pick, revert, or bisect in progress;
- unresolved conflicts or unmerged files;
- detached `HEAD`;
- existing user-staged changes;
- missing Git author or committer identity;
- a future-dated `HEAD`.

An empty repository is supported. A clean repository exits successfully without an empty commit:

```text
Nothing to commit. The working tree is clean.
```

## Input validation

Both values for `commitspan` must be whole integers greater than zero. Extra arguments are rejected. `autocommit` accepts no arguments.

```text
Usage:
  commitspan <duration> <commits-per-day>
  autocommit

Examples:
  commitspan 10 5
  autocommit
```

## Common errors

- **Not inside a Git repository:** change into a Git working tree or initialize one.
- **Git unavailable:** install Git and ensure it is on `PATH`.
- **Missing identity:** configure Git `user.name` and `user.email`.
- **Existing staged changes:** commit or unstage them manually before running Commit Master.
- **Unsafe Git operation:** complete or abort the active operation.
- **Hook or signing failure:** fix the reported issue and retry; working changes are preserved.
- **Recent `HEAD` leaves insufficient chronological slots:** use a higher per-day limit only if that history shape is intentional, or wait until additional valid dates are available.

## Development

Use any compatible package manager:

```bash
npm install
npm run build
```

Equivalent Yarn and pnpm commands are also supported.

## Author

[Safdar Azeem](https://github.com/safdar-azeem)

## License

[MIT](LICENSE)

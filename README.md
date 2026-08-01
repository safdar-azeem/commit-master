# Commit Master

Commit Master is a global TypeScript command-line package for creating one Git commit per logical file change. It provides two commands from one installation:

- `commitspan` distributes current changes across a historical calendar-day range.
- `autocommit` commits the current changes immediately.

Both commands operate on the Git repository associated with the terminal's current directory. Running either command from a nested directory resolves and processes the repository root; sibling repositories are never scanned.

## Requirements

- Node.js 18.18 or newer
- Git available on `PATH`
- A configured Git author name and email
- Yarn 1.x for installation and package development

Commit Master supports macOS, Linux, and Windows. Git paths are handled as NUL-delimited data and passed as process arguments, so spaces, Unicode characters, nested paths, hidden files, and names beginning with `-` are safe.

## Global installation with Yarn

Install the published package globally:

```bash
yarn global add commit-master
```

This exposes exactly these terminal commands:

```text
commitspan
autocommit
```

To develop this package locally:

```bash
yarn install
yarn build
yarn global add file:.
```

## `commitspan`

```bash
commitspan <duration> <commits-per-day>
```

For example:

```bash
commitspan 10 5
```

`duration` is a positive whole number of calendar days. The range is inclusive and ends on the current local date, so a 10-day run on August 10 covers August 1 through August 10. `commits-per-day` is the maximum number of commits assigned to each date.

Changes are ordered predictably as deleted, modified, renamed, and new files, with path-based ordering inside each group. Commit Master fills the oldest usable date first, continues forward chronologically, and stops after every detected change has been committed. It never creates empty filler commits.

The generated messages follow these patterns:

```text
Add src/users.ts
Update package.json
Delete src/legacy-config.ts
Rename src/old-name.ts to src/new-name.ts
```

Each date receives deterministic, increasing local times. Historical dates normally use times from 09:00 through 17:00. Current-day times never exceed the instant when the command began. The local UTC offset is calculated separately for every timestamp, which preserves the intended local time across daylight-saving transitions.

Commit Master assigns both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` to each newly created historical commit. It does not amend, rebase, rewrite, or otherwise change existing commits. If the current `HEAD` timestamp overlaps the requested range, only timestamps later than `HEAD` are usable; the displayed capacity reflects that safe constraint.

### Capacity

Nominal capacity is:

```text
duration × commits-per-day
```

For 10 days and 5 commits per day, nominal capacity is 50. Capacity can be smaller when existing `HEAD` history occupies part of the date range or, in an extreme current-day edge case, too few distinct seconds are available.

Capacity is checked before staging or committing anything. If 51 changes are found but only 50 timestamps are available, the command exits unsuccessfully and creates no commits. Increase either argument and run it again.

## `autocommit`

```bash
autocommit
```

`autocommit` takes a snapshot of the repository's current eligible changes, commits each logical change separately, and exits. It is not a watcher or background process. Git supplies the real current author and committer time for every commit; no dates are overridden.

If one file fails to stage or commit, processing stops immediately. Earlier successful commits remain in history, while the failed and unprocessed changes remain available. The command reports the failed path, Git's useful error output, the number of successful commits, and a non-zero exit status.

## Eligible changes and isolation

Both commands process:

- untracked, non-ignored files;
- modified tracked files;
- deleted tracked files;
- renames detected by Git;
- symbolic links according to normal Git behavior.

Ignored untracked files remain ignored. A rename is one logical change and one commit containing both its old and new path. Before every commit, Commit Master verifies that the index contains only the intended path or rename pair. The commit itself is also restricted with Git pathspecs.

An already populated staging area is deliberately not rewritten or reset. Commit Master stops before the first commit and asks you to commit or unstage those changes yourself. This preserves custom partial staging and prevents unrelated staged work from being combined with generated commits.

Normal Git hooks and commit-signing configuration are respected. Hooks are never bypassed. If a hook rejects a commit, that failure is reported and processing stops.

## Repository safety

Before committing, Commit Master rejects repositories with:

- a merge, rebase, cherry-pick, revert, or bisect in progress;
- unresolved or unmerged files;
- detached `HEAD`;
- existing staged changes;
- missing Git author identity;
- a latest commit timestamp in the future.

Repositories with no commits are supported: the first file commit establishes history. A clean repository exits successfully with:

```text
Nothing to commit. The working tree is clean.
```

Every Git process receives the resolved repository root as its explicit working directory. Commit Master never changes the Node process's global working directory, follows symlinks to scan outside the repository, scans adjacent projects, or constructs shell command strings.

## Input errors

These examples are rejected without modifying the repository:

```bash
commitspan
commitspan abc 5
commitspan 0 5
commitspan -10 5
commitspan 2.5 5
commitspan 10days 5
commitspan 10 0
commitspan 10 2.5
commitspan 10 5 extra
autocommit something
```

The CLI prints the supported usage:

```text
Usage:
  commitspan <duration> <commits-per-day>
  autocommit

Examples:
  commitspan 10 5
  autocommit
```

## Common errors

- **Not inside a Git repository:** change into a Git working tree or initialize one first.
- **Git is unavailable:** install Git and ensure its executable is on `PATH`.
- **Author information is missing:** configure `user.name` and `user.email` with Git.
- **Staging area already contains changes:** commit or unstage them manually, then retry.
- **Unsafe Git operation:** finish or abort the merge, rebase, cherry-pick, revert, or bisect.
- **Detached `HEAD`:** check out the intended branch before committing.
- **Commit span capacity is too small:** increase the duration or commits-per-day value.
- **A hook rejects a commit:** fix the hook-reported issue; successful earlier commits are retained.

## Package contents

The package has no runtime dependencies. TypeScript compiles the two shebang entry points and shared modules into `dist`; Yarn's global installation creates the platform-appropriate command links or Windows shims.

## Author

[Safdar Azeem](https://github.com/safdar-azeem)

## License

[MIT](LICENSE)

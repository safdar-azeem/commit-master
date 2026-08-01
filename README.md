# Git Commit CLI Toolkit

A command-line toolkit offering a collection of utilities for automatic file commits and custom backdated timestamping commits.

## Installation

Install globally with npm:

```bash
npm install --global commit-master
```

Or with Yarn:

```bash
yarn global add commit-master
```

## How to Use

Open your Git project in the terminal, or navigate to the project directory:

```bash
cd path/to/your-project
```

Then run one of the available commands inside that project:

```bash
autocommit
```

or:

```bash
commitspan <duration> <commits-per-day>
```

The commands work with the Git repository of the currently opened project.

## Automatic File Commits

Use `autocommit` inside your project to commit every current file change separately:

```bash
autocommit
```

Each added, updated, deleted, or renamed file receives its own commit.

Example commit messages:

```text
Add users.ts
Update package.json
Delete legacy-config.ts
Rename old-name.ts to new-name.ts
```

## Backdated Timestamping Commits

Use `commitspan` inside your project to distribute current file changes across previous calendar days:

```bash
commitspan 10 5
```

Arguments:

```text
10 = number of days
5 = maximum commits per day
```

The command automatically calculates how many days are required based on the number of changed files.

For example, 58 file changes with a limit of 5 commits per day will be distributed across 12 days.

## How It Works

The toolkit:

- Uses the Git repository of the currently opened project.
- Finds added, modified, deleted, and renamed files.
- Creates one commit for each logical file change.
- Generates a clear commit message from the change type.
- Uses the current timestamp with `autocommit`.
- Generates chronological backdated timestamps with `commitspan`.
- Automatically expands the date range when more days are required.
- Preserves existing commits and working-tree changes.
- Stops safely when the repository contains staged changes, conflicts, or an active Git operation.

## Examples

Open your project:

```bash
cd path/to/your-project
```

Commit all current changes immediately:

```bash
autocommit
```

Distribute commits across 10 days with up to 5 commits per day:

```bash
commitspan 10 5
```

Distribute commits across 30 days with up to 3 commits per day:

```bash
commitspan 30 3
```

## Author

[Safdar Azeem](https://github.com/safdar-azeem)

## License

[MIT](LICENSE)

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

Or with pnpm:

```bash
pnpm add --global commit-master
```

One global installation exposes all four commands: `autocommit`, `commitspan`, `gitpaths`, and `gitbundle`. Node.js 18.18 or newer and Git are required; no package manager is required at runtime.

## Visual Studio Code Extension

If you prefer to use this workflow inside Visual Studio Code, install the [Auto Commit Master extension](https://marketplace.visualstudio.com/items?itemName=SafdarAzeem.auto-commit-master) from the Visual Studio Marketplace.

The extension provides the Visual Studio Code experience, while this package provides the `autocommit`, `commitspan`, `gitpaths`, and `gitbundle` terminal commands.

## How to Use

Open your Git project in the terminal, or navigate to the project directory:

```bash
cd path/to/your-project
```

Then run one of the available commands inside that project:

```bash
autocommit
commitspan <duration> <commits-per-day>
gitpaths
gitbundle
```

The commands work with the Git repository of the currently opened project.

## Automatic Git Initialization

If the current project is not a Git repository, an interactive terminal asks:

```text
Git is not initialized in this project.
Initialize it now? (Y/n)
```

Press Enter or answer Yes to initialize Git in the current directory and continue the original command automatically. Answer No to cancel without changing the project.

CI, redirected input, and other non-interactive environments never initialize Git or wait for input. They ask you to initialize Git before running Commit Master. Git identity is never created or changed automatically.

This initialization flow applies to all four commands. After confirmation, the original command continues automatically in the newly initialized repository.

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

## Copy Changed File Paths

Use `gitpaths` to copy the absolute paths of eligible uncommitted files:

```bash
gitpaths
```

It collects staged changes, unstaged tracked changes, and untracked non-ignored files from the complete resolved repository. Deleted paths are included, and a rename appears once under its new path. Results are deduplicated and sorted by path.

Example clipboard content:

```text
/completeProjectPath/Design.md
/completeProjectPath/package.json
/completeProjectPath/src/components/Icon.vue
/completeProjectPath/src/index.ts
```

After a successful copy, the command prints only the number of copied paths. A clean tree does not overwrite the clipboard.

## Copy a Markdown Change Bundle

Use `gitbundle` to copy the complete current contents of eligible changed files as Markdown:

```bash
gitbundle
```

Example clipboard content:

````markdown
Repository: /completeProjectPath

### /completeProjectPath/package.json

```json
{
  "name": "example"
}
```

### /completeProjectPath/src/index.ts

```ts
export const ready = true
```

------------------------------
````

The bundle uses an extension-appropriate code-fence language and automatically lengthens fences when file content contains backticks. Deleted files contain `[FILE DELETED]`. Binary or unsupported special-file content is represented by `[BINARY FILE OMITTED]` so it cannot corrupt the clipboard. Symbolic links are included as link text and are not followed outside the repository.

## Default Clipboard Ignore Rules

Both clipboard commands use one shared ignore policy. Git's own ignore rules are respected first. Commit Master also excludes common generated output, dependencies, locks, media, archives, databases, and documents, including:

- `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, generated TypeScript files, `.DS_Store`, and Vite timestamp files
- `node_modules`, `dist`, `.next`, `.nuxt`, `Pods`, migrations, caches, generated folders, and platform build output
- logs, SQL/database artifacts, archives, native binaries, PDFs, office documents, CSV files, images, audio, and video

`package.json` is intentionally included. The centralized rules apply identically to `gitpaths` and `gitbundle`.

## Clipboard and Platform Support

Commit Master supports macOS, Windows, and Linux without shell-string execution. It uses the native macOS and Windows clipboard tools, with PowerShell preferred on Windows for reliable Unicode text. On Linux it uses the first available supported clipboard provider: `wl-copy`, `xclip`, `xsel`, PowerShell or `clip.exe` under WSL, or Termux clipboard tools.

The command reports success only after the clipboard process exits successfully. If no supported clipboard provider is available, it exits with `Unable to copy to the clipboard.`

## How It Works

The toolkit:

- Uses the Git repository of the currently opened project.
- Offers to initialize Git in the current project when needed.
- Finds added, modified, deleted, and renamed files.
- Creates one commit for each logical file change.
- Generates a clear commit message from the change type.
- Uses the current timestamp with `autocommit`.
- Generates chronological backdated timestamps with `commitspan`.
- Automatically expands the date range when more days are required.
- Copies absolute changed-file paths with `gitpaths`.
- Creates complete Markdown change bundles with `gitbundle`.
- Preserves existing commits and working-tree changes.
- Stops commit creation safely when the repository contains pre-existing staged changes, conflicts, or an active Git operation; clipboard commands intentionally include staged changes.

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

Copy changed-file paths:

```bash
gitpaths
```

Copy changed-file contents as a Markdown bundle:

```bash
gitbundle
```

## Author

[Safdar Azeem](https://github.com/safdar-azeem)

## License

[MIT](LICENSE)

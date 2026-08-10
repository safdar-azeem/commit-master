# Git Commit CLI Toolkit

A command-line collection of Git utilities for automatic per-file commits, historical commit scheduling, sharing changed files, and safe project stashing.

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

One global installation exposes all five commands: `gitauto`, `gitspan`, `gitpaths`, `gitbundle`, and `gitstash`. Node.js 18.18 or newer and Git are required; no package manager is required at runtime.

## How to Use

Open your Git project in the terminal, or navigate to the project directory:

```bash
cd path/to/your-project
```

Then run one of the available commands inside that project:

```bash
gitauto
gitspan <duration> <commits-per-day>
gitpaths
gitbundle
gitbundle ./frontend ./api
gitbundle --all [workspace-path]
gitbundle --save <name> ./frontend ./api
gitbundle @<name>
gitbundle --list
gitbundle --delete <name>
gitstash ["stash title"]
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

This initialization flow applies to the normal current-repository commands. `gitbundle` workspace discovery and explicit repository paths never initialize a directory; they only use Git repositories that already exist. After confirmation, the original command continues automatically in the newly initialized repository.

## Automatic File Commits

Use `gitauto` inside your project to commit every current file change separately:

```bash
gitauto
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

Use `gitspan` inside your project to distribute current file changes across previous calendar days:

```bash
gitspan 10 5
```

Arguments:

```text
10 = number of days
5 = maximum commits per day
```

The command automatically calculates how many days are required based on the number of changed files. Scheduling ignores the existing `HEAD` commit timestamp and only uses historical dates up through the current time, so a recent latest commit does not reduce capacity.

For example, 58 file changes with a limit of 5 commits per day will be distributed across 12 days. With 119 changes and `gitspan 10 5`, the range expands to 24 days.

## Copy Changed File Paths

Use `gitpaths` to copy the absolute paths of eligible uncommitted files:

```bash
gitpaths
```

It collects staged changes, unstaged tracked changes, and untracked non-ignored files from the complete resolved repository. Deleted paths are included, and a rename appears once under its new path. Results are deduplicated and sorted by path. Sensitive files remain visible as paths, but `gitpaths` never reads their contents.

Example clipboard content:

```text
/completeProjectPath/Design.md
/completeProjectPath/package.json
/completeProjectPath/src/components/Icon.vue
/completeProjectPath/src/index.ts
```

After a successful copy, the command prints `8 file paths copied.` using the actual count. A clean tree does not overwrite the clipboard.

## Copy a Markdown Change Bundle

Use `gitbundle` to copy the complete current contents of eligible changed files as Markdown:

```bash
gitbundle
```

Example clipboard content:

````markdown
Repository: /completeProjectPath

### [MODIFIED] package.json

```json
{
  "name": "example"
}
```

### [MODIFIED] src/index.ts

```ts
export const ready = true
```

------------------------------
````

The bundle uses an extension-appropriate code-fence language and automatically lengthens fences when file content contains backticks. It uses these explicit placeholders:

- `[SENSITIVE FILE OMITTED]` for environment files, credentials, private keys, and other protected files
- `[FILE DELETED]` for deleted files
- `[FILE NOT FOUND]` when a changed file disappears before it can be read
- `[FILE UNREADABLE]` for inaccessible or replaced files
- `[FILE TOO LARGE]` when one file exceeds 1 MiB
- `[BINARY FILE OMITTED]` for binary or unsupported special-file content

Commit Master never silently truncates file content. Individual files are limited to 1 MiB and the complete Markdown bundle is limited to 10 MiB. If the total limit is exceeded, the command stops before invoking the clipboard provider. Symbolic links are represented by their link target text and are never followed outside the repository.

After success, `gitbundle` prints `8 changed files bundled and copied.` using the actual count.

### Bundle Multiple Repositories

The no-argument command remains the single-repository workflow shown above. To review several repositories together, pass their roots (or directories inside them) to `gitbundle`:

```bash
gitbundle ./web-client ./api-service
gitbundle /path/to/workspace/web-client /path/to/workspace/api-service
```

Paths are resolved to Git roots and duplicate repositories are included once. The command makes one clipboard update only after all changed-file content has been read and the complete combined bundle passes the same 10 MiB safety limit. Its Markdown makes repository boundaries explicit:

````markdown
# Repository Bundle

Repositories: 2
Files: 7

## web-client

Path: /path/to/workspace/web-client
Changed files: 5

### [MODIFIED] src/App.vue

```vue
<!-- changed content -->
```
````

Use `--all` to discover repositories below a workspace directory:

```bash
gitbundle --all
gitbundle --all /path/to/workspace
```

Discovery is bounded to three directory levels and skips `.git`, dependency, build, cache, and other heavy generated directories. Once it finds a repository it does not scan through it. A clean repository is reported and excluded from the bundle; if every selected repository is clean, the existing clipboard content is left untouched.

Each file heading identifies its change type and uses a path relative to that repository. Renames include both paths; a rename with unchanged content uses `[NO CHANGES IN FILE - RENAMED ONLY]` instead of repeating the complete file.

### Save and Reuse Workspaces

Save a resolved set of repositories for use from any terminal directory:

```bash
gitbundle --save project-workspace ./web-client ./api-service
gitbundle --all --save project-workspace
gitbundle @project-workspace
```

Saved workspaces contain only a name and repository paths in the current user's Commit Master configuration directory (`$XDG_CONFIG_HOME/commit-master` or `~/.config/commit-master` on macOS/Linux, and `%APPDATA%\\commit-master` on Windows). No file contents or Git changes are stored.

Manage saved workspaces with:

```bash
gitbundle --list
gitbundle --delete project-workspace
```

Workspace names use letters, numbers, hyphens, and underscores. If a saved repository has been moved or deleted, `gitbundle @name` reports every unavailable path and does not substitute a different repository.

## Default Clipboard Ignore Rules

Both clipboard commands use one shared ignore policy. Git's own ignore rules are respected first. Commit Master additionally excludes:

- Exact names: `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `generated.ts`, `mongoose.gen.ts`, `resolvers.generated.ts`, `typeDefs.generated.ts`, `types.generated.ts`, `tsconfig.tsbuildinfo`, `tsconfig.node.tsbuildinfo`, and `.DS_Store`.
- Generated patterns: `*.generated.ts` and `vite.config.ts.timestamp-*`.
- Directories at any depth: `_locales`, `src-tauri/target`, `gen`, `temp`, `ffmpeg`, `migrations`, `sql`, `dist`, `.xcode`, `vendor/bundle`, `.git`, `Pods`, `.nuxt`, `.next`, `.idea`, `.bundle`, `node_modules`, and `cache`.
- Extensions: `.log`, `.sql`, `.onnx`, `.TAG`, `.pdf`, `.docx`, `.csv`, common image/audio/video formats, archives, database files, WebAssembly, and native binaries.

Filename, extension, and directory matching is case-insensitive and works at any nesting level. `package.json` is intentionally included. The centralized eligibility rules apply identically to `gitpaths` and `gitbundle`.

Sensitive paths—including `.env` variants, private-key formats, credential JSON files, `.npmrc`, `.pypirc`, and `.netrc`—remain in the shared eligible list. `gitpaths` copies only their paths, while `gitbundle` replaces their content with `[SENSITIVE FILE OMITTED]`, even when the file is already tracked by Git.

Control characters in copied path displays are escaped as readable sequences such as `\n`, `\r`, and `\t`; the real path remains unchanged for filesystem access. Markdown-sensitive heading characters are escaped without altering valid Unicode names.

## Clipboard and Platform Support

Commit Master supports macOS, Windows, and Linux without shell-string execution. It uses the native macOS and Windows clipboard tools, with PowerShell preferred on Windows for reliable Unicode text. On Linux it uses the first available supported clipboard provider: `wl-copy`, `xclip`, `xsel`, PowerShell or `clip.exe` under WSL, or Termux clipboard tools.

The command reports success only after the clipboard process exits successfully. On Linux, if no supported provider is available, it reports:

```text
Unable to copy to the clipboard.
Install wl-copy, xclip, or xsel.
```

Pressing Ctrl+C exits with status 130 and reports `Copy cancelled.` followed by `The clipboard was not updated.` Commit-specific counts are not shown for clipboard commands.

## Stash Project Changes

Use `gitstash` to save all current repository changes in a new Git stash:

```bash
gitstash
```

The default stash title is `Commit Master stash`. Provide one quoted argument to use an exact custom title containing spaces, Unicode, or punctuation:

```bash
gitstash "Before updating authentication"
```

Additional positional arguments are rejected with the concise `gitstash` usage message. The single accepted argument is always treated as the stash title, not as a Git option.

The command includes modified, staged, deleted, renamed, and untracked non-ignored files. Git-ignored files remain untouched. After success, both the working tree and staging area are clean, and all earlier stash entries remain available below the newly created `stash@{0}`.

Success output is intentionally minimal:

```text
Changes stashed successfully.
Changes stashed successfully: Before updating authentication
```

A clean repository returns `Nothing to stash. The working tree is clean.` without creating an empty entry. Unsafe merge, rebase, cherry-pick, revert, bisect, or conflict states are rejected before stash creation.

When Git is initialized through Commit Master, `gitstash` continues automatically and supports the unborn repository by using a temporary internal base. That base is removed from the branch after the stash is verified; no user commit is left behind.

Git must be able to resolve the user's configured identity because stash entries are stored as Git commit objects. Commit Master never invents or changes that identity.

Ctrl+C before stash creation exits with status 130 and reports:

```text
Stash cancelled.
Your changes were not removed.
```

If interruption arrives after Git created the stash, Commit Master verifies `refs/stash` and the working tree before reporting the final state.

Use standard Git commands to inspect or restore saved changes:

```bash
git stash list
git stash apply
git stash pop
```

`gitstash` only creates a stash; it never applies, pops, deletes, or overwrites an existing entry.

## How It Works

The toolkit:

- Uses the Git repository of the currently opened project.
- Offers to initialize Git in the current project when needed.
- Finds added, modified, deleted, and renamed files.
- Creates one commit for each logical file change.
- Generates a clear commit message from the change type.
- Uses the current timestamp with `gitauto`.
- Generates chronological backdated timestamps with `gitspan`, independent of the existing `HEAD` timestamp.
- Automatically expands the date range further into the past when more days are required.
- Copies absolute changed-file paths with `gitpaths`.
- Creates complete Markdown change bundles with `gitbundle`.
- Saves staged, unstaged, and untracked project changes with `gitstash`.
- Preserves existing commits and working-tree changes.
- Stops commit creation safely when the repository contains pre-existing staged changes, conflicts, or an active Git operation; clipboard commands intentionally include staged changes.

## Examples

Open your project:

```bash
cd path/to/your-project
```

Commit all current changes immediately:

```bash
gitauto
```

Distribute commits across 10 days with up to 5 commits per day:

```bash
gitspan 10 5
```

Distribute commits across 30 days with up to 3 commits per day:

```bash
gitspan 30 3
```

Copy changed-file paths:

```bash
gitpaths
```

Copy changed-file contents as a Markdown bundle:

```bash
gitbundle
```

Stash all project changes with the default title:

```bash
gitstash
```

Stash all project changes with a custom title:

```bash
gitstash "Work in progress"
```

## License

[MIT](LICENSE)

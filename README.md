# Git Commit CLI Toolkit

A command-line collection of Git utilities for automatic per-file commits, historical commit scheduling, sharing changed files, and safe project stashing.

## Features

- Automatic per-file Git commits
- Backdated commit scheduling
- Copy changed file paths
- Copy changed files as Markdown
- Bundle any folder without Git
- Bundle multiple repositories
- Save and reuse repository workspaces
- Safe project stashing
- File or text clipboard output
- macOS, Windows, and Linux support

## Installation

Install globally

```bash
npm install --global commit-master
```

Node.js 18.18 or newer is required. Git is required for Git-specific commands. `filebundle` does not require Git.

## How to Use

Open your project in the terminal:

```bash
cd path/to/your-project
```

Available commands:

```bash
gitauto
gitspan <duration> <commits-per-day>
gitpaths
gitbundle
filebundle
filebundle --output
filebundle --output file
filebundle --output text
gitbundle ./frontend ./api
gitbundle --all [workspace-path]
gitbundle --save <name> ./frontend ./api
gitbundle @<name>
gitbundle --list
gitbundle --delete <name>
gitstash ["stash title"]
```

Git commands work with the repository of the current project. `filebundle` works with the current folder whether or not it is a Git repository.

## Automatic Git Initialization

If the current project is not a Git repository, Commit Master asks:

```text
Git is not initialized in this project.
Initialize it now? (Y/n)
```

Press Enter or answer Yes to initialize Git and continue the original command. Answer No to cancel without changing the project.

Non-interactive environments such as CI never initialize Git or wait for input.

`gitbundle` workspace discovery and explicit repository paths only use repositories that already exist. `filebundle` never checks for or initializes Git.

## Automatic File Commits

Use `gitauto` to commit every current file change separately:

```bash
gitauto
```

Each added, updated, deleted, or renamed file receives its own commit.

Example:

```text
Add users.ts
Update package.json
Delete legacy-config.ts
Rename old-name.ts to new-name.ts
```

## Backdated Timestamping Commits

Use `gitspan` to distribute current file changes across previous calendar days:

```bash
gitspan 10 5
```

Arguments:

```text
10 = number of days
5 = maximum commits per day
```

If the requested range is too small for all changes, Commit Master automatically expands it further into the past.

For example, 58 changes with a maximum of 5 commits per day require 12 days.

## Copy Changed File Paths

Use `gitpaths` to copy the absolute paths of eligible changed files:

```bash
gitpaths
```

It collects:

- staged changes
- unstaged tracked changes
- untracked non-ignored files
- deleted paths
- renamed paths under their new name

Results are deduplicated and sorted.

Example clipboard content:

```text
/completeProjectPath/Design.md
/completeProjectPath/package.json
/completeProjectPath/src/components/Icon.vue
/completeProjectPath/src/index.ts
```

`gitpaths` copies file paths only and never reads their contents.

If there are no eligible changes, your existing clipboard is left unchanged.

## Copy a Markdown Change Bundle

Use `gitbundle` to copy eligible changed files as Markdown:

```bash
gitbundle
```

The bundle includes file paths, change types, and readable file contents.

Commit Master handles common file types automatically:

- SVG files are included as readable source.
- DOCX files include extractable document text.
- PDF files include extractable page text.
- PPTX files include extractable slide text and speaker notes.
- Embedded images and charts are represented with placeholders.
- Images, audio, video, archives, databases, models, native binaries, and similar binary files are shown with placeholders instead of raw binary data.
- Sensitive files are shown without exposing their contents.
- Scanned or image-only PDFs are not OCR'd.

Common placeholders include:

```text
[SENSITIVE FILE OMITTED]
[FILE DELETED]
[FILE NOT FOUND]
[FILE UNREADABLE]
[FILE TOO LARGE]
[Embedded image omitted]
[Embedded chart omitted]
[PDF contains no extractable text - OCR not enabled]
```

### Bundle Limits

To prevent unexpectedly large clipboard payloads:

- individual textual files are limited to 1 MiB
- extracted document text is limited to 1 MiB
- DOCX, PDF, and PPTX source files may be up to 32 MiB
- the complete Markdown bundle is limited to 10 MiB

Binary files represented by placeholders are not loaded into the Markdown bundle.

Symbolic links are represented safely and are not followed outside the repository.

### Bundle Multiple Repositories

Bundle several repositories together:

```bash
gitbundle ./frontend ./api
gitbundle /path/to/web-client /path/to/api-service
```

Repository paths are resolved to their Git roots, and duplicate repositories are included only once.

Use `--all` to discover repositories below a workspace:

```bash
gitbundle --all
gitbundle --all /path/to/workspace
```

Discovery skips common dependency, build, Git, and cache directories. Clean repositories are reported but excluded from the final bundle.

### Save and Reuse Workspaces

Save a repository workspace:

```bash
gitbundle --save project-workspace ./frontend ./api
gitbundle --all --save project-workspace
```

Use it later:

```bash
gitbundle @project-workspace
```

List saved workspaces:

```bash
gitbundle --list
```

Delete one:

```bash
gitbundle --delete project-workspace
```

Workspace names support letters, numbers, hyphens, and underscores.

Saved workspaces store repository paths only. They do not store file contents or Git changes.

## Bundle Any Folder Without Git

Use `filebundle` to bundle files from any folder:

```bash
cd ~/Documents/project-files
filebundle
```

Unlike `gitbundle`, `filebundle` does not use Git. It recursively bundles eligible files from the current folder.

By default, `filebundle` creates a `.md` file outside the selected project and copies that file itself to the clipboard.

### Copy Markdown Text Instead

Set text output:

```bash
filebundle --output text
```

Return to file output:

```bash
filebundle --output file
```

Check the current setting:

```bash
filebundle --output
```

The preference is global and applies across terminals, folders, and projects.

`file` is the default output mode.

`filebundle` does not use `.gitignore`. A `.gitignore` file is treated as a normal file, while Commit Master's built-in exclusions still apply.

## Default Clipboard Ignore Rules

Commit Master automatically skips common generated, dependency, build, cache, lock, and temporary files.

### Ignored Files

Exact names include:

```text
yarn.lock
pnpm-lock.yaml
bun.lockb
Cargo.lock
generated.ts
mongoose.gen.ts
resolvers.generated.ts
typeDefs.generated.ts
types.generated.ts
tsconfig.tsbuildinfo
tsconfig.node.tsbuildinfo
.DS_Store
```

Generated patterns include:

```text
*.generated.ts
vite.config.ts.timestamp-*
```

### Ignored Directories

These are ignored at any depth:

```text
_locales
src-tauri/target
gen
temp
ffmpeg
dist
.xcode
vendor/bundle
.git
Pods
.nuxt
.next
.idea
.bundle
node_modules
cache
```

Noise extensions such as these are also ignored:

```text
.log
.TAG
.csv
```

`package.json` is intentionally included.

### Binary and Document Files

`gitpaths` omits common binary and document files because it copies filesystem paths intended for review.

`gitbundle` keeps useful assets visible:

- SVG is included as readable source.
- DOCX, PDF, and PPTX include extractable text.
- Images, media, archives, databases, models, WASM, native binaries, and other binary files appear with content-omitted placeholders.

## Sensitive Files

Sensitive paths remain visible when useful, but their contents are protected.

Examples include:

```text
.env
.env.*
private keys
credential JSON files
.npmrc
.pypirc
.netrc
```

Behavior:

- `gitpaths` copies their paths only.
- `gitbundle` replaces their contents with `[SENSITIVE FILE OMITTED]`.

This applies even when the sensitive file is already tracked by Git.

## Clipboard and Platform Support

Commit Master supports macOS, Windows, and Linux.

### macOS

Text and file clipboard operations use native macOS clipboard capabilities.

### Windows

File output is copied as a native file item, and text clipboard operations support Unicode paths and content.

### Linux

For normal `filebundle` file output, Commit Master automatically installs and uses its native clipboard helper.

Supported architectures:

```text
x64
arm64
```

You do not need to install `wl-copy`, `xclip`, or `xsel` for normal file-mode usage.

For text clipboard commands such as:

```bash
gitpaths
gitbundle
filebundle --output text
```

Commit Master uses an available Linux clipboard provider such as:

```text
wl-copy
xclip
xsel
```

If none is available, Commit Master reports that a supported clipboard provider is required.

Headless Linux environments do not provide a desktop file clipboard.

File pasting also depends on the destination application supporting file clipboard items.

## Stash Project Changes

Use `gitstash` to save current project changes:

```bash
gitstash
```

The default stash title is:

```text
Commit Master stash
```

Use a custom title:

```bash
gitstash "Before updating authentication"
```

`gitstash` includes:

- staged changes
- unstaged changes
- deleted files
- renamed files
- untracked non-ignored files

Git-ignored files remain untouched.

Existing stash entries are preserved.

If there is nothing to stash:

```text
Nothing to stash. The working tree is clean.
```

Unsafe merge, rebase, cherry-pick, revert, bisect, or conflict states are rejected before stash creation.

Use normal Git commands to inspect or restore stashes:

```bash
git stash list
git stash apply
git stash pop
```

`gitstash` creates a stash only. It never automatically applies, pops, deletes, or overwrites an existing entry.

## License

[MIT](LICENSE)

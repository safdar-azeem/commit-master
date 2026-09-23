# Linux file clipboard release checklist

The source tree intentionally contains no native binary. Do not publish the
main `commit-master` version until both matching platform packages are built
and published. `.github/workflows/release-npm.yml` stages the binaries and
publishes the two optional dependencies before the main package.

Before tagging, confirm that the three npm package names are publishable by the
release account and that all three package versions, the Rust crate version,
and the release tag match. Configure `NPM_TOKEN` for the workflow.

The workflow resolves one Rust lockfile, compiles on native x64 and arm64
Linux runners, checks the ELF architecture and executable bit, generates
third-party license notices, and tests the main package before publishing.
For the first release, the dependency-install step temporarily removes the
unpublished optional helper dependencies from its CI-only manifest and disables
the package lock; it restores the real manifest before tests and publication.
The platform packages are published before Commit Master. The binaries are
included in npm tarballs; `filebundle` never downloads executable code at
runtime.

Each publication step packs one deterministic tarball, then checks the exact
name and version in the npm registry. On a retry, an already-published version
is skipped only when its registry SHA-512 integrity equals the prepared
tarball's integrity. A conflicting version fails the release; the workflow
never attempts to overwrite an immutable npm version. The same check applies
to the main package after both helpers.

After publication, validate a fresh global install with no `wl-copy`, `xclip`,
or `xsel` on PATH on representative GNOME Wayland, GNOME X11, KDE Wayland,
and KDE X11 desktops. Check a real file paste, Unicode/reserved-character
paths, headless failure, Ctrl+C, and the saved-file path on clipboard failure.
Automated provider mocks do not establish desktop paste compatibility.

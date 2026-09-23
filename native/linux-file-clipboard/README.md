# Linux file clipboard helper

This MIT-licensed helper accepts one absolute regular-file path, percent-encodes
it as a `file:` URI, and owns the desktop clipboard after its launcher exits.
Wayland offers both `x-special/gnome-copied-files` and `text/uri-list`; X11
offers the GNOME format on GNOME-family desktops and `text/uri-list` elsewhere.
It uses the Wayland data-control protocol or X11 directly, without invoking
`wl-copy`, `xclip`, or `xsel`. A Wayland compositor without data-control may use
its XWayland display if available. A graphical session is required.

The source uses `wl-clipboard-rs` (MIT OR Apache-2.0), `x11-clipboard` (MIT),
`x11rb` (MIT OR Apache-2.0), `url` (MIT OR Apache-2.0), and `libc`
(MIT OR Apache-2.0). Release builds must retain their license notices in
the published package's third-party notice bundle.

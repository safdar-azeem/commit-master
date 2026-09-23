//! Linux file clipboard selection owner. The short-lived launcher waits for a
//! readiness line from a detached owner; the owner stays alive to serve pastes.
use std::env;
use std::error::Error;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use wl_clipboard_rs::copy::{MimeSource, MimeType, Options, PreparedCopy, Source};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn is_gnome_family(desktop: &str) -> bool {
    let desktop = desktop.to_lowercase();
    ["gnome", "unity", "cinnamon", "pantheon"]
        .iter()
        .any(|name| desktop.contains(name))
}

fn x11_format<'a>(desktop: &str, gnome: &'a str, uri: &'a str) -> (&'static str, &'a str) {
    if is_gnome_family(desktop) {
        ("x-special/gnome-copied-files", gnome)
    } else {
        ("text/uri-list", uri)
    }
}

fn formats(path: &Path) -> Result<(String, String)> {
    if !path.is_absolute() || !fs::metadata(path)?.is_file() {
        return Err("Expected an existing absolute regular file".into());
    }
    let uri = url::Url::from_file_path(path)
        .map_err(|_| "Unable to encode the file path as a file URI")?;
    Ok((format!("copy\n{uri}\n"), format!("{uri}\r\n")))
}

fn prepare_wayland(gnome: &str, uri: &str) -> Result<PreparedCopy> {
    let mut options = Options::new();
    options.foreground(true);
    let sources = vec![
        MimeSource {
            source: Source::Bytes(gnome.as_bytes().to_vec().into()),
            mime_type: MimeType::Specific("x-special/gnome-copied-files".into()),
        },
        MimeSource {
            source: Source::Bytes(uri.as_bytes().to_vec().into()),
            mime_type: MimeType::Specific("text/uri-list".into()),
        },
    ];
    Ok(options.prepare_copy_multi(sources)?)
}

fn confirm_owner() -> Result<()> {
    println!("READY");
    std::io::stdout().flush()?;
    let mut acknowledgement = [0u8; 1];
    std::io::stdin().read_exact(&mut acknowledgement)?;
    if acknowledgement[0] != b'Y' {
        return Err("Clipboard launch was cancelled".into());
    }
    // The launcher may now exit without terminating this selection owner.
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, 0) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    println!("OWNED");
    std::io::stdout().flush()?;
    Ok(())
}

fn x11(gnome: &str, uri: &str) -> Result<()> {
    let clipboard = x11_clipboard::Clipboard::new()?;
    // x11-clipboard exposes a single selection target. Choose the file-manager
    // convention for this desktop; Wayland offers both simultaneously.
    let desktop = env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let (mime, payload) = x11_format(&desktop, gnome, uri);
    let target = clipboard.setter.get_atom(mime)?;
    let selection = clipboard.setter.atoms.clipboard;
    clipboard.store(selection, target, payload.as_bytes())?;
    confirm_owner()?;
    loop {
        thread::sleep(Duration::from_secs(1));
        if clipboard.setter.connection.get_selection_owner(selection)?.reply()?.owner
            != clipboard.setter.window
        {
            return Ok(());
        }
    }
}

fn serve(path: &Path) -> Result<()> {
    let (gnome, uri) = formats(path)?;
    let session = env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let has_wayland = env::var_os("WAYLAND_DISPLAY").is_some();
    let has_x11 = env::var_os("DISPLAY").is_some();
    if !has_wayland && !has_x11 {
        return Err("No graphical Wayland or X11 clipboard session is available".into());
    }
    // Prefer the session's native protocol. XWayland remains available where
    // a compositor does not expose a data-control protocol to CLI clients.
    if has_wayland && (session == "wayland" || !has_x11) {
        match prepare_wayland(&gnome, &uri) {
            Ok(prepared) => {
                confirm_owner()?;
                return Ok(prepared.serve()?);
            }
            Err(error) if !has_x11 => return Err(error),
            Err(_) => return x11(&gnome, &uri),
        }
    }
    if has_x11 { return x11(&gnome, &uri); }
    let prepared = prepare_wayland(&gnome, &uri)?;
    confirm_owner()?;
    Ok(prepared.serve()?)
}

fn launch(path: &Path) -> Result<()> {
    // Check before spawning so errors never look like a successful copy.
    formats(path)?;
    if env::var_os("WAYLAND_DISPLAY").is_none() && env::var_os("DISPLAY").is_none() {
        return Err("No graphical Wayland or X11 clipboard session is available".into());
    }
    let mut command = Command::new(env::current_exe()?);
    command.arg("--serve").arg(path)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 { return Err(std::io::Error::last_os_error()); }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let mut output = BufReader::new(child.stdout.take().ok_or("Missing helper readiness pipe")?);
    let mut line = String::new();
    output.read_line(&mut line)?;
    if line.trim() != "READY" {
        let mut detail = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            stderr.read_to_string(&mut detail)?;
        }
        let status = child.wait()?;
        return Err(format!("Linux clipboard owner did not start: {} (status: {status})", detail.trim()).into());
    }
    child.stdin.take().ok_or("Missing helper acknowledgement pipe")?.write_all(b"Y")?;
    line.clear();
    output.read_line(&mut line)?;
    if line.trim() != "OWNED" {
        return Err("Linux clipboard owner did not confirm selection ownership".into());
    }
    Ok(())
}

fn main() {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let first = arguments.next();
    let serve_mode = first.as_deref() == Some(std::ffi::OsStr::new("--serve"));
    let path = if serve_mode { arguments.next() } else { first };
    let result = match path {
        Some(path) if arguments.next().is_none() => {
            if serve_mode { serve(Path::new(&path)) } else { launch(Path::new(&path)) }
        }
        _ => Err("Usage: commit-master-file-clipboard <absolute-file-path>".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_file_uri_without_losing_file_copy_formats() {
        let directory = env::temp_dir()
            .join(format!("commit-master-clipboard-{}", std::process::id()))
            .join("My Project")
            .join("文档");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("résumé #1?.md");
        fs::write(&path, b"bundle").unwrap();
        let (gnome, generic) = formats(&path).unwrap();
        assert!(gnome.starts_with("copy\nfile:///"));
        assert!(generic.starts_with("file:///"));
        assert!(gnome.contains("My%20Project/%E6%96%87%E6%A1%A3/r%C3%A9sum%C3%A9%20%231%3F.md"));
        assert!(generic.contains("My%20Project/%E6%96%87%E6%A1%A3/r%C3%A9sum%C3%A9%20%231%3F.md"));
        assert!(generic.ends_with("\r\n"));
        fs::remove_dir_all(env::temp_dir().join(format!("commit-master-clipboard-{}", std::process::id()))).unwrap();
    }

    #[test]
    fn requires_an_existing_absolute_regular_file() {
        assert!(formats(Path::new("relative.md")).is_err());
    }

    #[test]
    fn selects_gnome_family_or_generic_x11_representation() {
        for desktop in ["GNOME", "Unity", "Cinnamon", "Pantheon", "ubuntu:GNOME"] {
            assert!(is_gnome_family(desktop));
        }
        for desktop in ["KDE", "XFCE", "unknown", ""] {
            assert!(!is_gnome_family(desktop));
        }
        assert_eq!(x11_format("GNOME", "copy\nfile:///a\n", "file:///a\r\n").0,
            "x-special/gnome-copied-files");
        assert_eq!(x11_format("KDE", "copy\nfile:///a\n", "file:///a\r\n").0,
            "text/uri-list");
    }
}

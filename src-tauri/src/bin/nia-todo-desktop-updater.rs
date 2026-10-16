#[cfg(not(all(unix, not(target_os = "macos"), not(target_os = "android"))))]
fn main() {
    eprintln!("nia-todo Debian updater is only available on Linux");
    std::process::exit(1);
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
mod linux {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use minisign_verify::{PublicKey, Signature};
    use rand::random;
    use std::{
        env,
        ffi::CString,
        fs::{self, File, OpenOptions},
        io::{Read, Write},
        mem::MaybeUninit,
        os::fd::{AsRawFd, FromRawFd, RawFd},
        os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        path::{Path, PathBuf},
        process::{Command, ExitStatus, Stdio},
        thread,
        time::Duration,
    };

    const PUBLIC_KEY: &str = "RWSJt15V25pErHT7xEbWod9OSpwZvp97V84wmvjOkV13O2epbmElzWl8";
    const UPDATER_PATH: &str = "/usr/lib/nia-todo-desktop/nia-todo-desktop-updater";
    const APP_PATH: &str = "/usr/bin/nia-todo-desktop";
    const ROOT_STAGE: &str = "/var/lib/nia-todo-desktop/updater";
    const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
    const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_BENEATH: u64 = 0x08;

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    fn fail(message: impl AsRef<str>) -> ! {
        eprintln!("{}", message.as_ref());
        std::process::exit(1);
    }

    fn valid_token(token: &str) -> bool {
        token.len() == 32
            && token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn trusted_comment_version(comment: &str) -> Result<&str, String> {
        let mut versions = comment
            .split('\t')
            .filter_map(|field| field.strip_prefix("version:"));
        let version = versions
            .next()
            .filter(|value| {
                let mut parts = value.split('.');
                parts.clone().count() == 3
                    && parts.all(|part| {
                        !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
                    })
            })
            .ok_or_else(|| "Debian update signature version is invalid".to_string())?;
        if versions.next().is_some() {
            return Err("Debian update signature contains multiple versions".to_string());
        }
        Ok(version)
    }

    fn parse_uid(value: &str) -> Result<u32, String> {
        if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
            return Err("PKEXEC_UID is invalid".to_string());
        }
        let uid = value
            .parse::<u32>()
            .map_err(|_| "PKEXEC_UID is invalid".to_string())?;
        if uid == 0 {
            return Err("PKEXEC_UID must identify an unprivileged user".to_string());
        }
        let exists = unsafe { libc::getpwuid(uid) };
        if exists.is_null() {
            return Err("PKEXEC_UID does not identify a local user".to_string());
        }
        Ok(uid)
    }

    fn process_alive(pid: u32) -> bool {
        unsafe {
            libc::kill(pid as libc::pid_t, 0) == 0 || *libc::__errno_location() == libc::EPERM
        }
    }

    fn open_run_root() -> Result<RawFd, String> {
        let path = CString::new("/run").unwrap();
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err("Unable to open /run safely".to_string())
        } else {
            Ok(fd)
        }
    }

    fn open_user_file(uid: u32, token: &str, name: &str, max_size: u64) -> Result<File, String> {
        let run_fd = open_run_root()?;
        let relative = CString::new(format!(
            "user/{uid}/nia-todo-desktop-updates/{token}/{name}"
        ))
        .map_err(|_| "Invalid staged update path".to_string())?;
        let how = OpenHow {
            flags: (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
            mode: 0,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                run_fd,
                relative.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            ) as RawFd
        };
        unsafe { libc::close(run_fd) };
        if fd < 0 {
            return Err(format!("Unable to open staged {name} safely"));
        }
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            unsafe { libc::close(fd) };
            return Err(format!("Unable to inspect staged {name}"));
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG
            || stat.st_uid != uid
            || stat.st_nlink != 1
            || stat.st_size <= 0
            || stat.st_size as u64 > max_size
            || stat.st_mode & 0o077 != 0
            || stat.st_mode & (libc::S_ISUID | libc::S_ISGID) != 0
        {
            unsafe { libc::close(fd) };
            return Err(format!("Staged {name} has unsafe metadata"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn ensure_root_stage() -> Result<PathBuf, String> {
        let path = PathBuf::from(ROOT_STAGE);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "Root update staging directory is missing".to_string())?;
        if !metadata.file_type().is_dir() || metadata.uid() != 0 || metadata.mode() & 0o777 != 0o700
        {
            return Err("Root update staging directory is unsafe".to_string());
        }
        Ok(path)
    }

    fn acquire_lock(root: &Path) -> Result<File, String> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(root.join("update.lock"))
            .map_err(|error| error.to_string())?;
        let metadata = lock.metadata().map_err(|error| error.to_string())?;
        if !metadata.file_type().is_file()
            || metadata.uid() != 0
            || metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
        {
            return Err("Root update lock is unsafe".to_string());
        }
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Another nia-todo update is already running".to_string());
        }
        Ok(lock)
    }

    fn copy_to_root(mut source: File, destination: &Path, max_size: u64) -> Result<(), String> {
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(destination)
            .map_err(|error| error.to_string())?;
        let mut copied = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let count = source.read(&mut chunk).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .ok_or_else(|| "Staged update is too large".to_string())?;
            if copied > max_size {
                return Err("Staged update is too large".to_string());
            }
            target
                .write_all(&chunk[..count])
                .map_err(|error| error.to_string())?;
        }
        target.sync_all().map_err(|error| error.to_string())
    }

    fn read_signature(path: &Path) -> Result<Signature, String> {
        let encoded = fs::read_to_string(path).map_err(|error| error.to_string())?;
        if encoded.len() > MAX_SIGNATURE_BYTES as usize {
            return Err("Debian update signature is too large".to_string());
        }
        let document = STANDARD
            .decode(encoded.trim())
            .map_err(|_| "Debian update signature encoding is invalid".to_string())?;
        let document = String::from_utf8(document)
            .map_err(|_| "Debian update signature encoding is invalid".to_string())?;
        Signature::decode(&document).map_err(|_| "Debian update signature is invalid".to_string())
    }

    fn verify_package(path: &Path, signature: &Signature) -> Result<(), String> {
        let key = PublicKey::from_base64(PUBLIC_KEY)
            .map_err(|_| "Debian update public key is invalid".to_string())?;
        let mut verifier = key
            .verify_stream(signature)
            .map_err(|_| "Debian update signature is invalid".to_string())?;
        let mut package = File::open(path).map_err(|error| error.to_string())?;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let count = package
                .read(&mut chunk)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            verifier.update(&chunk[..count]);
        }
        verifier
            .finalize()
            .map_err(|_| "Debian update signature verification failed".to_string())
    }

    fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
        let output = Command::new(program)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
            .stdin(Stdio::null())
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!("Package validation command failed: {program}"));
        }
        String::from_utf8(output.stdout)
            .map(|value| value.trim().to_string())
            .map_err(|_| "Package validation output is invalid".to_string())
    }

    fn compare_versions(target: &str, current: &str) -> Result<(), String> {
        let status = Command::new("/usr/bin/dpkg")
            .args(["--compare-versions", target, "gt", current])
            .env_clear()
            .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Debian update is not newer than the installed version".to_string())
        }
    }

    fn install_package(path: &Path) -> Result<(), String> {
        let status = Command::new("/usr/bin/dpkg")
            .arg("--install")
            .arg(path)
            .env_clear()
            .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
            .env("DEBIAN_FRONTEND", "noninteractive")
            .stdin(Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("dpkg failed to install the nia-todo update".to_string())
        }
    }

    fn privileged(token: &str) -> Result<(), String> {
        if unsafe { libc::geteuid() } != 0 {
            return Err("Privileged updater must run as root".to_string());
        }
        if !valid_token(token) {
            return Err("Update token is invalid".to_string());
        }
        let uid =
            parse_uid(&env::var("PKEXEC_UID").map_err(|_| "PKEXEC_UID is required".to_string())?)?;
        let package_source = open_user_file(uid, token, "package.deb", MAX_PACKAGE_BYTES)?;
        let signature_source = open_user_file(uid, token, "package.deb.sig", MAX_SIGNATURE_BYTES)?;

        let root = ensure_root_stage()?;
        let _lock = acquire_lock(&root)?;
        let work = root.join(format!("{:032x}", random::<u128>()));
        fs::create_dir(&work).map_err(|error| error.to_string())?;
        fs::set_permissions(&work, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        let package_path = work.join("package.deb");
        let signature_path = work.join("package.deb.sig");
        let result = (|| {
            copy_to_root(package_source, &package_path, MAX_PACKAGE_BYTES)?;
            copy_to_root(signature_source, &signature_path, MAX_SIGNATURE_BYTES)?;
            let signature = read_signature(&signature_path)?;
            verify_package(&package_path, &signature)?;
            let signed_version = trusted_comment_version(signature.trusted_comment())?;

            let package_path_text = package_path
                .to_str()
                .ok_or_else(|| "Root update path is invalid".to_string())?;
            let package_name =
                command_output("/usr/bin/dpkg-deb", &["-f", package_path_text, "Package"])?;
            if package_name != "nia-todo-desktop" {
                return Err("Debian update has the wrong package name".to_string());
            }
            let architecture = command_output(
                "/usr/bin/dpkg-deb",
                &["-f", package_path_text, "Architecture"],
            )?;
            let host_architecture = command_output("/usr/bin/dpkg", &["--print-architecture"])?;
            if architecture != "amd64" || architecture != host_architecture {
                return Err("Debian update has the wrong architecture".to_string());
            }
            let package_version =
                command_output("/usr/bin/dpkg-deb", &["-f", package_path_text, "Version"])?;
            if package_version != signed_version {
                return Err(
                    "Debian update package version does not match its signature".to_string()
                );
            }
            let current_version = command_output(
                "/usr/bin/dpkg-query",
                &["-W", "-f=${Version}", "nia-todo-desktop"],
            )?;
            compare_versions(&package_version, &current_version)?;
            install_package(&package_path)
        })();
        let _ = fs::remove_dir_all(&work);
        result
    }

    fn run_pkexec(token: &str) -> Result<ExitStatus, String> {
        Command::new("/usr/bin/pkexec")
            .arg(UPDATER_PATH)
            .arg("privileged")
            .arg(token)
            .status()
            .map_err(|error| error.to_string())
    }

    fn launch(token: &str, app_pid: &str) -> Result<(), String> {
        if unsafe { libc::geteuid() } == 0 {
            return Err("Update launcher must not run as root".to_string());
        }
        if !valid_token(token) {
            return Err("Update token is invalid".to_string());
        }
        let app_pid = app_pid
            .parse::<u32>()
            .map_err(|_| "Application PID is invalid".to_string())?;
        if app_pid == 0 {
            return Err("Application PID is invalid".to_string());
        }
        let status = run_pkexec(token)?;
        let stage = PathBuf::from(format!(
            "/run/user/{}/nia-todo-desktop-updates/{token}",
            unsafe { libc::geteuid() }
        ));
        let _ = fs::remove_dir_all(stage);

        if status.success() {
            for _ in 0..100 {
                if !process_alive(app_pid) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Command::new(APP_PATH)
                .spawn()
                .map_err(|error| format!("Unable to restart nia-todo: {error}"))?;
            Ok(())
        } else {
            if !process_alive(app_pid) {
                let _ = Command::new(APP_PATH).spawn();
            }
            Err("Update authorization or installation failed".to_string())
        }
    }

    pub fn main() {
        let args: Vec<String> = env::args().collect();
        let result = match args.as_slice() {
            [_, mode, token, app_pid] if mode == "launch" => launch(token, app_pid),
            [_, mode, token] if mode == "privileged" => privileged(token),
            _ => Err("Invalid updater invocation".to_string()),
        };
        if let Err(error) = result {
            fail(error);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn token_is_exact_lowercase_hex() {
            assert!(valid_token("0123456789abcdef0123456789abcdef"));
            assert!(!valid_token("0123456789ABCDEF0123456789ABCDEF"));
            assert!(!valid_token("../23456789abcdef0123456789abcdef"));
            assert!(!valid_token("1234"));
        }

        #[test]
        fn uid_parser_rejects_root_and_noncanonical_values() {
            assert!(parse_uid("0").is_err());
            assert!(parse_uid("01").is_err());
            assert!(parse_uid("-1").is_err());
            assert!(parse_uid("not-a-uid").is_err());
        }

        #[test]
        fn trusted_comment_requires_one_exact_version_field() {
            assert_eq!(
                trusted_comment_version("timestamp:1\tfile:update.deb\tversion:3.4.0").unwrap(),
                "3.4.0"
            );
            assert!(trusted_comment_version("version:3.4.0\tversion:3.4.1").is_err());
            assert!(trusted_comment_version("timestamp:1\tfile:update.deb").is_err());
        }
    }
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn main() {
    linux::main();
}

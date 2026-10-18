//! Own only the bundled backend, never an external/IDE/remote Java process.
//! Windows creates the child atomically inside a non-inheritable kill-on-close job.
//! Even TerminateProcess/Ctrl+C skips Rust destructors, the OS closes the job handle.
use std::{ffi::OsStr, fs::File, io, path::Path};

/// JVM startup does not support the verbatim prefix returned by Windows canonicalize.
/// Do not blindly strip it: reserved names, trailing dots and long paths can change meaning.
/// dunce only converts paths that have an equivalent ordinary Windows representation.
pub fn launch_path(path: &Path) -> io::Result<&Path> {
    let path = dunce::simplified(path);
    #[cfg(target_os = "windows")]
    if matches!(path.components().next(), Some(std::path::Component::Prefix(prefix)) if prefix.kind().is_verbatim())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "内置 Java 无法使用此 Windows 扩展路径；请使用较短、无特殊文件名的普通安装或数据目录。",
        ));
    }
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
pub type BackendProcess = std::process::Child;

#[cfg(not(target_os = "windows"))]
pub fn spawn(
    program: &Path,
    args: &[&OsStr],
    directory: &Path,
    stdout: File,
    stderr: File,
) -> io::Result<BackendProcess> {
    std::process::Command::new(program)
        .args(args)
        .current_dir(directory)
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        fs::OpenOptions,
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
            process::ExitStatusExt,
        },
        process::ExitStatus,
    };
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{
                DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
            },
            System::{
                JobObjects::{
                    CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{
                    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
                    GetExitCodeProcess, InitializeProcThreadAttributeList,
                    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
                    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST,
                    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
                },
            },
        },
    };

    pub struct BackendProcess {
        process: OwnedHandle,
        job: OwnedHandle,
        id: u32,
    }

    impl AsHandle for BackendProcess {
        fn as_handle(&self) -> BorrowedHandle<'_> {
            self.process.as_handle()
        }
    }

    impl BackendProcess {
        pub fn id(&self) -> u32 {
            self.id
        }
        pub fn kill(&mut self) -> io::Result<()> {
            // Only this backend and descendants belong to this private job.
            unsafe { TerminateJobObject(raw(&self.job), 1) }.map_err(io::Error::from)
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.wait_for(0)
        }
        pub fn wait(&mut self) -> io::Result<ExitStatus> {
            self.wait_for(INFINITE)?
                .ok_or_else(|| io::Error::other("等待内置后端退出未完成"))
        }
        fn wait_for(&self, timeout: u32) -> io::Result<Option<ExitStatus>> {
            // SAFETY: OwnedHandle keeps this process alive throughout both API calls.
            match unsafe { WaitForSingleObject(raw(&self.process), timeout) } {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    unsafe { GetExitCodeProcess(raw(&self.process), &mut code) }
                        .map_err(io::Error::from)?;
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
    }

    fn raw(handle: &impl AsRawHandle) -> HANDLE {
        HANDLE(handle.as_raw_handle())
    }
    unsafe fn own(handle: HANDLE) -> OwnedHandle {
        // SAFETY: caller transfers one newly created, valid owning handle.
        unsafe { OwnedHandle::from_raw_handle(handle.0) }
    }
    fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = value.encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "进程路径或参数包含空字符",
            ));
        }
        value.push(0);
        Ok(value)
    }

    // Quote UTF-16 arguments according to Windows CRT rules, including embedded
    // quotes and trailing backslashes. No shell, lossy Unicode conversion or interpolation.
    fn command_line(program: &Path, args: &[&OsStr]) -> io::Result<Vec<u16>> {
        let mut result = Vec::new();
        for value in std::iter::once(program.as_os_str()).chain(args.iter().copied()) {
            let value = wide(value)?;
            if !result.is_empty() {
                result.push(b' ' as u16);
            }
            result.push(b'"' as u16);
            let mut slashes = 0;
            for &unit in &value[..value.len() - 1] {
                if unit == b'\\' as u16 {
                    slashes += 1;
                    continue;
                }
                result.extend(std::iter::repeat_n(
                    b'\\' as u16,
                    if unit == b'"' as u16 {
                        slashes * 2 + 1
                    } else {
                        slashes
                    },
                ));
                result.push(unit);
                slashes = 0;
            }
            result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
            result.push(b'"' as u16);
        }
        result.push(0);
        Ok(result)
    }

    fn inherit(handle: &impl AsRawHandle) -> io::Result<OwnedHandle> {
        let mut duplicate = HANDLE::default();
        // SAFETY: source is borrowed; only the returned duplicate is inheritable.
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                raw(handle),
                GetCurrentProcess(),
                &mut duplicate,
                0,
                true,
                DUPLICATE_SAME_ACCESS,
            )
        }
        .map_err(io::Error::from)?;
        Ok(unsafe { own(duplicate) })
    }

    struct Attributes {
        storage: Vec<usize>,
        initialized: bool,
    }
    impl Attributes {
        fn new() -> io::Result<Self> {
            let mut size = 0;
            // First call deliberately fails with the required buffer size.
            let _ = unsafe { InitializeProcThreadAttributeList(None, 2, None, &mut size) };
            if size == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut attributes = Self {
                storage: vec![0; size.div_ceil(size_of::<usize>())],
                initialized: false,
            };
            // Aligned storage is never resized and lives until after CreateProcessW.
            unsafe {
                InitializeProcThreadAttributeList(Some(attributes.ptr()), 2, None, &mut size)
            }
            .map_err(io::Error::from)?;
            attributes.initialized = true;
            Ok(attributes)
        }
        fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            LPPROC_THREAD_ATTRIBUTE_LIST(self.storage.as_mut_ptr().cast())
        }
        fn handles(&mut self, key: u32, values: &[HANDLE]) -> io::Result<()> {
            // SAFETY: arrays remain alive through attribute deletion and process creation.
            unsafe {
                UpdateProcThreadAttribute(
                    self.ptr(),
                    0,
                    key as usize,
                    Some(values.as_ptr().cast::<c_void>()),
                    std::mem::size_of_val(values),
                    None,
                    None,
                )
            }
            .map_err(io::Error::from)
        }
    }
    impl Drop for Attributes {
        fn drop(&mut self) {
            if self.initialized {
                unsafe { DeleteProcThreadAttributeList(self.ptr()) };
            }
        }
    }

    pub fn spawn(
        program: &Path,
        args: &[&OsStr],
        directory: &Path,
        stdout: File,
        stderr: File,
    ) -> io::Result<BackendProcess> {
        // Both lpApplicationName and argv[0] must use the same JVM-compatible path.
        // Leave non-path arguments untouched and preserve the atomic kill-on-close Job.
        let program = launch_path(program)?;
        let directory = launch_path(directory)?;
        let application = wide(program.as_os_str())?;
        let directory = wide(directory.as_os_str())?;
        let mut command = command_line(program, args)?;
        // Null security attributes: anonymous job handle cannot be inherited.
        let job = unsafe { own(CreateJobObjectW(None, PCWSTR::null()).map_err(io::Error::from)?) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                raw(&job),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(io::Error::from)?;
        let stdin = OpenOptions::new().read(true).open("NUL")?;
        let stdin = inherit(&stdin)?;
        let stdout = inherit(&stdout)?;
        let stderr = inherit(&stderr)?;
        let jobs = [raw(&job)];
        let handles = [raw(&stdin), raw(&stdout), raw(&stderr)];
        let mut attributes = Attributes::new()?;
        attributes.handles(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
        attributes.handles(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.ptr();
        let mut info = PROCESS_INFORMATION::default();
        // SAFETY: writable command, UTF-16 buffers, aligned attribute storage and
        // handle arrays all live until this call returns. Only stdio is inherited;
        // the job handle stays exclusively in the owner. Job assignment is atomic
        // with process creation, eliminating spawn -> assign crash races.
        unsafe {
            CreateProcessW(
                PCWSTR(application.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                None,
                PCWSTR(directory.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        }
        .map_err(io::Error::from)?;
        let process = unsafe { own(info.hProcess) };
        drop(unsafe { own(info.hThread) });
        Ok(BackendProcess {
            process,
            job,
            id: info.dwProcessId,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            process::{Child, Command},
            sync::atomic::{AtomicU64, Ordering},
            thread,
            time::{Duration, Instant},
        };
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

        const FIXTURE_DIRECTORY: &str = "AISHELL_BACKEND_JOB_TEST_DIRECTORY";
        const OWNER: &str = "backend_process::platform::tests::owner_fixture";
        const WORKER: &str = "backend_process::platform::tests::worker_fixture";
        const GRANDCHILD: &str = "backend_process::platform::tests::grandchild_fixture";
        static NEXT: AtomicU64 = AtomicU64::new(0);

        struct Fixture {
            directory: std::path::PathBuf,
            executable: std::path::PathBuf,
        }
        impl Fixture {
            fn new() -> Self {
                let directory = std::env::temp_dir().join(format!(
                    "aishell-job-中文 空格-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&directory).unwrap();
                let executable = directory.join("backend fixture.exe");
                fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
                Self {
                    directory,
                    executable,
                }
            }
            fn start_owner(&self) -> Cleanup {
                use std::os::windows::process::CommandExt;
                Cleanup(
                    Command::new(std::env::current_exe().unwrap())
                        .args(["--exact", OWNER, "--nocapture"])
                        .env(FIXTURE_DIRECTORY, &self.directory)
                        .creation_flags(CREATE_NO_WINDOW.0)
                        .spawn()
                        .unwrap(),
                )
            }
            fn read_pid(&self, file: &str) -> u32 {
                let deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    if let Ok(text) = fs::read_to_string(self.directory.join(file)) {
                        if let Ok(id) = text.trim().parse() {
                            return id;
                        }
                    }
                    assert!(Instant::now() < deadline, "fixture did not publish {file}");
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                // Only flat files in this test's unique temporary directory, never app data.
                if let Ok(files) = fs::read_dir(&self.directory) {
                    for file in files.flatten() {
                        let _ = fs::remove_file(file.path());
                    }
                }
                let _ = fs::remove_dir(&self.directory);
            }
        }
        struct Cleanup(Child);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        fn fixture_directory() -> Option<std::path::PathBuf> {
            std::env::var_os(FIXTURE_DIRECTORY).map(Into::into)
        }
        fn process(id: u32) -> OwnedHandle {
            unsafe { own(OpenProcess(PROCESS_SYNCHRONIZE, false, id).unwrap()) }
        }
        fn assert_running(handle: &OwnedHandle) {
            assert_eq!(unsafe { WaitForSingleObject(raw(handle), 0) }, WAIT_TIMEOUT);
        }
        fn assert_exited(handle: &OwnedHandle) {
            assert_eq!(
                unsafe { WaitForSingleObject(raw(handle), 5_000) },
                WAIT_OBJECT_0
            );
        }

        // Isolated subprocess fixtures. Normal cargo test runs return immediately.
        #[test]
        fn owner_fixture() {
            let Some(directory) = fixture_directory() else {
                return;
            };
            let output = File::create(directory.join("stdout.log")).unwrap();
            let error = File::create(directory.join("stderr.log")).unwrap();
            let _backend = spawn(
                &directory.join("backend fixture.exe"),
                &[
                    OsStr::new("--exact"),
                    OsStr::new(WORKER),
                    OsStr::new("--nocapture"),
                ],
                &directory,
                output,
                error,
            )
            .unwrap();
            loop {
                thread::sleep(Duration::from_secs(1));
            }
        }
        #[test]
        fn worker_fixture() {
            let Some(directory) = fixture_directory() else {
                return;
            };
            println!("backend stdout 中文");
            eprintln!("backend stderr 中文");
            fs::write(directory.join("child.pid"), std::process::id().to_string()).unwrap();
            // An ordinary descendant should inherit the private job, but not its handle.
            let mut descendant = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", GRANDCHILD, "--nocapture"])
                .spawn()
                .unwrap();
            descendant.wait().unwrap();
        }
        #[test]
        fn grandchild_fixture() {
            let Some(directory) = fixture_directory() else {
                return;
            };
            fs::write(
                directory.join("grandchild.pid"),
                std::process::id().to_string(),
            )
            .unwrap();
            loop {
                thread::sleep(Duration::from_secs(1));
            }
        }

        #[test]
        fn forced_owner_exit_releases_children_file_lock_and_allows_restart() {
            // Simulates taskkill/forced dev shutdown; no Exit callback or Rust Drop runs.
            let unrelated = Fixture::new();
            let _unrelated_owner = unrelated.start_owner();
            let unrelated_child = process(unrelated.read_pid("child.pid"));
            for _ in 0..2 {
                let fixture = Fixture::new();
                let mut owner = fixture.start_owner();
                let child = process(fixture.read_pid("child.pid"));
                let descendant = process(fixture.read_pid("grandchild.pid"));
                assert_running(&child);
                assert_running(&descendant);
                assert!(
                    fs::copy(std::env::current_exe().unwrap(), &fixture.executable).is_err(),
                    "running child must lock its executable"
                );
                owner.0.kill().unwrap();
                owner.0.wait().unwrap();
                assert_exited(&child);
                assert_exited(&descendant);
                // Equivalent to Tauri overwriting a runtime DLL on the next build.
                fs::copy(std::env::current_exe().unwrap(), &fixture.executable).unwrap();
                assert_running(&unrelated_child);
                assert!(fs::read_to_string(fixture.directory.join("stdout.log"))
                    .unwrap()
                    .contains("backend stdout 中文"));
                assert!(fs::read_to_string(fixture.directory.join("stderr.log"))
                    .unwrap()
                    .contains("backend stderr 中文"));
            }
        }

        #[test]
        fn manual_kill_wait_drop_and_spawn_failure_keep_process_ownership() {
            let fixture = Fixture::new();
            let output = || File::create(fixture.directory.join("manual.log")).unwrap();
            let args = [
                OsStr::new("/D"),
                OsStr::new("/C"),
                OsStr::new("ping -n 60 127.0.0.1 >NUL"),
            ];
            let program = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap())
                .join("System32/cmd.exe");
            let mut child = spawn(&program, &args, &fixture.directory, output(), output()).unwrap();
            assert!(child.try_wait().unwrap().is_none());
            child.kill().unwrap();
            assert!(!child.wait().unwrap().success());
            assert!(child.try_wait().unwrap().is_some());
            let child = spawn(&program, &args, &fixture.directory, output(), output()).unwrap();
            let handle = child.as_handle().try_clone_to_owned().unwrap();
            drop(child);
            assert_exited(&handle);
            assert!(spawn(
                &fixture.directory.join("missing-java.exe"),
                &[],
                &fixture.directory,
                output(),
                output()
            )
            .is_err());
        }

        #[test]
        fn bundled_java_runs_with_redirected_logs_and_releases_resources() {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"));
            let program = directory.join("target/debug/runtime/bin/java.exe");
            // Other checkouts may not have prepared their optional bundled runtime.
            if !program.is_file() {
                return;
            }
            let fixture = Fixture::new();
            let output = File::create(fixture.directory.join("java.out")).unwrap();
            let error = File::create(fixture.directory.join("java.err")).unwrap();
            let mut java = spawn(
                &program,
                &[OsStr::new("-version")],
                &fixture.directory,
                output,
                error,
            )
            .unwrap();
            assert!(java.wait().unwrap().success());
            drop(java);
            assert!(fs::read_to_string(fixture.directory.join("java.err"))
                .unwrap()
                .contains("version"));
        }

        #[test]
        fn bundled_java_runs_from_verbatim_resource_path() {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"));
            let program = std::env::var_os("AISHELL_TEST_JAVA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| directory.join("bundle/runtime/bin/java.exe"));
            if !program.is_file() {
                assert!(
                    std::env::var_os("AISHELL_TEST_JAVA").is_none(),
                    "AISHELL_TEST_JAVA must point to a real runtime"
                );
                eprintln!("No prepared Java runtime; skipping optional JVM smoke test");
                return;
            }
            // Tauri's installed resource directory uses the same prefix as std::canonicalize.
            let program = fs::canonicalize(program).unwrap();
            assert!(program.as_os_str().to_string_lossy().starts_with(r"\\?\"));
            let fixture = Fixture::new();
            let working_directory = fs::canonicalize(&fixture.directory).unwrap();
            let stdout = fixture.directory.join("verbatim-java.out");
            let stderr = fixture.directory.join("verbatim-java.err");
            let mut java = spawn(
                &program,
                &[OsStr::new("--version")],
                &working_directory,
                File::create(&stdout).unwrap(),
                File::create(&stderr).unwrap(),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let status = loop {
                if let Some(status) = java.try_wait().unwrap() {
                    break status;
                }
                assert!(Instant::now() < deadline, "Java --version did not finish");
                thread::sleep(Duration::from_millis(20));
            };
            drop(java);
            // A JVM crash message can include a path encoded in the Windows code page.
            let logs = format!(
                "{}\n{}",
                String::from_utf8_lossy(&fs::read(stdout).unwrap()),
                String::from_utf8_lossy(&fs::read(stderr).unwrap())
            );
            assert!(
                status.success(),
                "Java failed for installed-style resource path: {logs}"
            );
            assert!(
                logs.contains("OpenJDK"),
                "Expected real Java version: {logs}"
            );
            assert!(!logs.contains("fatal error"));
        }

        #[test]
        fn launch_paths_simplify_without_changing_argument_or_filename_semantics() {
            assert_eq!(
                launch_path(Path::new(r"\\?\E:\中文 空格\runtime\bin\java.exe")).unwrap(),
                Path::new(r"E:\中文 空格\runtime\bin\java.exe")
            );
            assert_eq!(
                launch_path(Path::new(r"E:\中文 空格\backend\app.jar")).unwrap(),
                Path::new(r"E:\中文 空格\backend\app.jar")
            );
            assert_eq!(
                launch_path(Path::new(r"\\server\share\java.exe")).unwrap(),
                Path::new(r"\\server\share\java.exe")
            );
            for path in [
                r"\\?\C:\CON\java.exe",
                r"\\?\C:\folder.\java.exe",
                r"\\?\C:\folder \java.exe",
                r"\\?\UNC\server\share\java.exe",
            ] {
                assert_eq!(
                    launch_path(Path::new(path)).unwrap_err().kind(),
                    io::ErrorKind::InvalidInput
                );
            }
            let long_path = format!(r"\\?\C:\{}\java.exe", "long\\".repeat(60));
            assert!(launch_path(Path::new(&long_path)).is_err());
            let program = launch_path(Path::new(r"\\?\C:\中文 空格\java.exe")).unwrap();
            let argument = OsStr::new(r"literal \\?\C:\keep unchanged");
            let command = command_line(program, &[argument]).unwrap();
            assert_eq!(
                String::from_utf16(&command[..command.len() - 1]).unwrap(),
                format!(
                    "\"{}\" \"{}\"",
                    program.display(),
                    argument.to_str().unwrap()
                )
            );
        }

        #[test]
        fn quotes_preserve_spaces_unicode_quotes_and_trailing_slashes() {
            let encoded = command_line(
                Path::new(r"C:\目录\java.exe"),
                &[
                    OsStr::new(""),
                    OsStr::new("a b"),
                    OsStr::new("a\"b"),
                    OsStr::new("C:\\目录\\"),
                ],
            )
            .unwrap();
            assert_eq!(
                String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
                "\"C:\\目录\\java.exe\" \"\" \"a b\" \"a\\\"b\" \"C:\\目录\\\\\""
            );
            assert!(command_line(Path::new("java.exe"), &[OsStr::new("bad\0arg")]).is_err());
        }
    }
}

#[cfg(target_os = "windows")]
pub use platform::{spawn, BackendProcess};

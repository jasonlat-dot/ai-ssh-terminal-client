//! Resolve a Trace ID inside the application's diagnostics directory only.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const MISSING: &str = "未找到这次请求的日志，可能已过期清理，或请求尚未生成日志。";

fn redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取请求日志，请检查日志目录的访问权限。".into()),
    }
}

pub(crate) fn find(directory: &Path, trace_id: &str) -> Result<PathBuf, String> {
    if trace_id.is_empty()
        || trace_id.len() > 128
        || !trace_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("无效的 Trace ID。".into());
    }
    let Some(root_meta) = metadata(directory)? else {
        return Err(MISSING.into());
    };
    if !root_meta.is_dir() || redirect(&root_meta) {
        return Err(MISSING.into());
    }
    let root = fs::canonicalize(directory).map_err(|_| MISSING.to_owned())?;
    let entries = fs::read_dir(&root).map_err(|_| "无法读取请求日志目录。".to_owned())?;
    let mut days = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取请求日志目录。".to_owned())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(date) = chrono::NaiveDate::parse_from_str(name, "%Y-%m-%d") else {
            continue;
        };
        if date.format("%Y-%m-%d").to_string() != name {
            continue;
        }
        let Some(meta) = metadata(&entry.path())? else {
            continue;
        };
        if !meta.is_dir() || redirect(&meta) {
            continue;
        }
        let day = fs::canonicalize(entry.path()).map_err(|_| MISSING.to_owned())?;
        if day.parent() == Some(root.as_path()) {
            days.push(day);
        }
    }
    // A request spanning midnight may have two files. Reveal its latest segment.
    days.sort_unstable_by(|a, b| b.cmp(a));
    for day in days {
        let candidate = day.join(format!("{trace_id}.log"));
        let Some(meta) = metadata(&candidate)? else {
            continue;
        };
        if !meta.is_file() || redirect(&meta) {
            continue;
        }
        let file = fs::canonicalize(candidate).map_err(|_| MISSING.to_owned())?;
        if file.parent() == Some(day.as_path()) {
            return Ok(file);
        }
    }
    Err(MISSING.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn write(root: &Path, day: &str, file: &str) -> PathBuf {
        let path = root.join(day).join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "fixture").unwrap();
        fs::canonicalize(path).unwrap()
    }
    #[test]
    fn finds_exact_log_trace_in_latest_date_ignoring_other_extensions() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "2026-10-19", "trace-123.log");
        write(dir.path(), "2026-10-20", "trace-123.jsonl");
        let expected = write(dir.path(), "2026-10-20", "trace-123.log");
        write(dir.path(), "2026-10-21", "another-trace.log");
        write(dir.path(), "2026-10-21", "trace-123.json");
        write(dir.path(), "2026-10-21", "trace-123.jsonl");
        assert_eq!(find(dir.path(), "trace-123").unwrap(), expected);
    }
    #[test]
    fn ignores_json_files_and_reports_missing_logs_without_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        for extension in ["json", "jsonl"] {
            let ignored = write(
                dir.path(),
                "2026-10-19",
                &format!("old-{extension}.{extension}"),
            );
            assert!(find(dir.path(), &format!("old-{extension}")).is_err());
            assert_eq!(fs::read_to_string(ignored).unwrap(), "fixture");
        }
        assert!(find(dir.path(), "missing")
            .unwrap_err()
            .contains("过期清理"));
        assert!(!dir.path().join("missing.log").exists());
        assert!(find(&dir.path().join("absent"), "missing").is_err());
        assert!(!dir.path().join("absent").exists());
    }
    #[test]
    fn rejects_paths_and_does_not_search_arbitrary_directories_or_fuzzy_names() {
        let dir = tempfile::tempdir().unwrap();
        for id in [
            "",
            "../secret",
            "..\\secret",
            "C:\\secret",
            "id.log",
            "id/other",
            "id\0",
            "id\n",
        ] {
            assert_eq!(find(dir.path(), id).unwrap_err(), "无效的 Trace ID。");
        }
        assert!(find(dir.path(), &"x".repeat(129)).is_err());
        write(dir.path(), "other", "trace.log");
        write(dir.path(), "2026-02-30", "trace.log");
        write(dir.path(), "2026-1-1", "trace.log");
        write(dir.path(), "2026-10-20/nested", "trace.log");
        write(dir.path(), "2026-10-20", "trace-other.log");
        fs::create_dir_all(dir.path().join("2026-10-20/trace.log")).unwrap();
        assert!(find(dir.path(), "trace").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_redirected_dates_or_files() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = write(outside.path(), "2026-10-19", "trace.log");
        symlink(file.parent().unwrap(), dir.path().join("2026-10-19")).unwrap();
        fs::create_dir_all(dir.path().join("2026-10-20")).unwrap();
        symlink(file, dir.path().join("2026-10-20/trace.log")).unwrap();
        assert!(find(dir.path(), "trace").is_err());
    }
}

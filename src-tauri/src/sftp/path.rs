use super::{Error, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub fn relative(value: &str, windows: bool) -> Result<PathBuf> {
    let mut result = PathBuf::new();
    for part in value.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.chars().any(|c| c.is_control() || "\\*?".contains(c))
        {
            return Err(Error::local("不安全的清单路径"));
        }
        if windows {
            let base = part.split('.').next().unwrap_or("").to_uppercase();
            if part.ends_with(['.', ' '])
                || part.contains([':', '<', '>', '"', '|'])
                || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str())
                || ["COM", "LPT"].iter().any(|prefix| {
                    base.strip_prefix(prefix).is_some_and(|n| {
                        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)
                    })
                })
            {
                return Err(Error::local("清单含 Windows 不支持的文件名"));
            }
        }
        result.push(part);
    }
    if !result.is_relative() {
        return Err(Error::local("清单不能使用绝对路径"));
    }
    Ok(result)
}

pub fn validate_manifest(items: &[super::Item], windows: bool) -> Result<()> {
    let mut paths = HashMap::new();
    let mut spellings = HashMap::new();
    for item in items {
        relative(&item.relative_path, windows)?;
        if item.kind != "FILE" && item.kind != "DIRECTORY" {
            return Err(Error::local("不支持符号链接或特殊文件"));
        }
        let key = if windows {
            item.relative_path.to_lowercase()
        } else {
            item.relative_path.clone()
        };
        if paths.insert(key, item.kind.as_str()).is_some() {
            return Err(Error::local("清单中存在重复或大小写冲突的路径"));
        }
        if windows {
            let mut prefix = String::new();
            for part in item.relative_path.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if let Some(old) = spellings.insert(prefix.to_lowercase(), prefix.clone()) {
                    if old != prefix {
                        return Err(Error::local("清单目录存在大小写冲突"));
                    }
                }
            }
        }
    }
    for key in paths.keys() {
        let mut parent = key.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if paths.get(prefix) == Some(&"FILE") {
                return Err(Error::local("清单文件和目录路径冲突"));
            }
            parent = prefix;
        }
    }
    Ok(())
}

// Check every existing component; never follow a symlink outside the selected directory.
pub fn destination(root: &Path, value: &str) -> Result<PathBuf> {
    let relative = relative(value, cfg!(windows))?;
    let mut target = root.to_path_buf();
    for component in relative.components() {
        target.push(component);
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(Error::local("本地目标包含符号链接"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escape_and_windows_aliases() {
        for name in ["../a", "/etc/passwd", "a//b", "a/../b", "a\\b", "a\n", "a*"] {
            assert!(relative(name, false).is_err(), "{name}");
        }
        for name in [
            "C:/a",
            "a:stream",
            "CON.txt",
            "aux",
            "a.",
            "a ",
            "LPT1.log",
            "COM¹",
            "foo/<bar>",
        ] {
            assert!(relative(name, true).is_err(), "{name}");
        }
        assert_eq!(
            relative("演示/空目录", true).unwrap(),
            PathBuf::from("演示/空目录")
        );
    }
    #[test]
    fn rejects_case_and_file_parent_conflicts() {
        let item = |path: &str| super::super::Item {
            relative_path: path.into(),
            kind: "FILE".into(),
            ..Default::default()
        };
        assert!(validate_manifest(&[item("A/a"), item("a/b")], true).is_err());
        assert!(validate_manifest(&[item("a"), item("a/b")], false).is_err());
        assert!(validate_manifest(&[item("a"), item("A")], false).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_destination() {
        let root = std::env::temp_dir().join(format!("sftp-path-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/tmp", root.join("escape")).unwrap();
        assert!(destination(&root, "escape/file").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

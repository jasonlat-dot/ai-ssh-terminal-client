//! One-time, copy-first migration from the old desktop identity, before WebView startup.
use std::{fs, io, path::Path};
use tauri::{plugin::TauriPlugin, Manager, Runtime};

const LEGACY_ID: &str = "com.jasonlat.shellpilot.rust-preview";
const CURRENT_ID: &str = "com.jasonlat.shellpilot";

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("workspace-migration")
        .setup(|app, _| {
            if app.config().identifier != CURRENT_ID {
                return Ok(());
            }
            let local = app.path().app_local_data_dir()?;
            let roaming = app.path().app_data_dir()?;
            let old_local = local.with_file_name(LEGACY_ID);
            migrate_root(&old_local, &local, &old_local, &local)?;
            if roaming != local {
                migrate_root(
                    &roaming.with_file_name(LEGACY_ID),
                    &roaming,
                    &old_local,
                    &local,
                )?;
            }
            Ok(())
        })
        .build()
}

fn directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if linked(&metadata) => {
            Err(io::Error::other("迁移路径不能是符号链接或目录联接"))
        }
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT, including junctions
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn relocated_directory(path: &Path, old: &Path, new: &Path) -> Option<std::path::PathBuf> {
    let path = dunce::simplified(path);
    let old = dunce::simplified(old);
    let mut parts = path.components();
    for component in old.components() {
        let next = parts.next()?;
        #[cfg(windows)]
        let equal = next
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&component.as_os_str().to_string_lossy());
        #[cfg(not(windows))]
        let equal = next == component;
        if !equal {
            return None;
        }
    }
    Some(new.join(parts.as_path()))
}

fn migrate_root(old: &Path, current: &Path, old_local: &Path, new_local: &Path) -> io::Result<()> {
    if !directory(old)? || old == current {
        return Ok(());
    }
    if directory(current)? {
        // A finished migration or a real fresh installation must never be overwritten.
        if current.join("workspace-migration.json").is_file()
            || current.join("workspace.json").is_file()
        {
            return Ok(());
        }
        if fs::read_dir(current)?.next().is_some() {
            return Err(io::Error::other(
                "正式数据目录已存在且尚未迁移，请备份并核对目录后重试；旧数据未修改",
            ));
        }
    }
    // SQLite must be closed before copying a database and its WAL together.
    #[cfg(windows)]
    let _database_guard = {
        use std::os::windows::fs::OpenOptionsExt;
        let database = old.join("backend-data/shellpilot.sqlite3");
        if database.is_file() {
            Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(database)
                    .map_err(|_| {
                        io::Error::other(
                            "请先从托盘完全退出旧版 ShellPilot，再启动新版完成数据迁移",
                        )
                    })?,
            )
        } else {
            None
        }
    };
    let stage = current.with_file_name(format!(
        "{}.migration",
        current.file_name().unwrap().to_string_lossy()
    ));
    if stage.exists() && !directory(&stage)? {
        return Err(io::Error::other("迁移暂存路径无效"));
    }
    copy_tree(old, &stage)?;
    let old_config = stage.join("rust-backend.json");
    let new_config = stage.join("workspace.json");
    if old_config.is_file() {
        let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&old_config)?)?;
        if let Some(path) = config.get("dataDirectory").and_then(|value| value.as_str()) {
            if let Some(relocated) = relocated_directory(Path::new(path), old_local, new_local) {
                config["dataDirectory"] = relocated.to_string_lossy().into_owned().into();
            }
        }
        fs::write(&new_config, serde_json::to_vec_pretty(&config)?)?;
        fs::remove_file(old_config)?;
        // The old config backup contains absolute paths into the previous root.
        for name in ["rust-backend.json.bak", "rust-backend.json.tmp"] {
            let obsolete = stage.join(name);
            if obsolete.is_file() {
                fs::remove_file(obsolete)?;
            }
        }
    }
    fs::write(
        stage.join("workspace-migration.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1, "source": old, "originalPreserved": true,
        }))?,
    )?;
    if current.exists() {
        fs::remove_dir(current)?;
    } // verified empty above; never recursive
    fs::rename(stage, current)?;
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    if !directory(source)? {
        return Err(io::Error::other("迁移源目录无效"));
    }
    if target.exists() && !directory(target)? {
        return Err(io::Error::other("迁移目标目录无效"));
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        // WebView transient caches/locks are rebuilt, persistent Local Storage and IndexedDB are copied.
        if matches!(
            name.to_string_lossy().as_ref(),
            "Cache"
                | "Code Cache"
                | "GPUCache"
                | "ShaderCache"
                | "Crashpad"
                | "BrowserMetrics"
                | "LOCK"
                | "SingletonLock"
                | "SingletonCookie"
                | "SingletonSocket"
        ) {
            continue;
        }
        if linked(&fs::symlink_metadata(entry.path())?) {
            return Err(io::Error::other(
                "迁移内容包含符号链接或目录联接，请先核对旧数据目录",
            ));
        }
        let destination = target.join(name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if kind.is_file() {
            if destination.exists() && linked(&fs::symlink_metadata(&destination)?) {
                return Err(io::Error::other("迁移目标包含符号链接"));
            }
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn migrated_sqlite_keeps_dpapi_credentials_and_refuses_an_open_writer() {
        use shellpilot_server::{model::ConnectionRequest, store::Store};
        let temporary = tempfile::tempdir().unwrap();
        let old = temporary.path().join(LEGACY_ID);
        let new = temporary.path().join(CURRENT_ID);
        let database = old.join("backend-data/shellpilot.sqlite3");
        let store = Store::open(&database).unwrap();
        let connection = store
            .save(
                ConnectionRequest {
                    connection_name: "migration fixture".into(),
                    host: "127.0.0.1".into(),
                    port: 22,
                    username: "fixture".into(),
                    password: Some("fixture-password".into()),
                    strict_host_key_check: Some(false),
                    ..Default::default()
                },
                false,
            )
            .unwrap();
        assert!(
            migrate_root(&old, &new, &old, &new).is_err(),
            "an open database must never be copied"
        );
        assert!(!new.exists());
        drop(store);
        migrate_root(&old, &new, &old, &new).unwrap();
        let reopened = Store::open(&new.join("backend-data/shellpilot.sqlite3")).unwrap();
        assert_eq!(
            reopened.get(&connection.connection_id).unwrap().username,
            "fixture"
        );
        assert_eq!(
            reopened
                .credentials(&connection.connection_id)
                .unwrap()
                .password
                .as_deref(),
            Some("fixture-password")
        );
        let case_variant = old.to_string_lossy().to_uppercase();
        assert_eq!(
            relocated_directory(&Path::new(&case_variant).join("backend-data"), &old, &new),
            Some(new.join("backend-data"))
        );
        assert!(database.is_file());
    }

    #[test]
    fn migrates_database_attachments_preferences_and_browser_storage_preserving_originals() {
        let temporary = tempfile::tempdir().unwrap();
        let old = temporary.path().join(LEGACY_ID);
        let new = temporary.path().join(CURRENT_ID);
        fs::create_dir_all(old.join("backend-data/attachments")).unwrap();
        fs::write(old.join("backend-data/shellpilot.sqlite3"), b"database").unwrap();
        fs::write(old.join("backend-data/attachments/item"), b"attachment").unwrap();
        fs::create_dir_all(old.join("EBWebView/Default/Local Storage/leveldb")).unwrap();
        fs::write(
            old.join("EBWebView/Default/Local Storage/leveldb/prefs"),
            b"theme,wallpaper,user-id",
        )
        .unwrap();
        fs::write(
            old.join("rust-backend.json"),
            serde_json::to_vec(
                &serde_json::json!({"dataDirectory":old.join("backend-data"),"autoStart":false}),
            )
            .unwrap(),
        )
        .unwrap();
        migrate_root(&old, &new, &old, &new).unwrap();
        assert_eq!(
            fs::read(new.join("backend-data/shellpilot.sqlite3")).unwrap(),
            b"database"
        );
        assert_eq!(
            fs::read(new.join("backend-data/attachments/item")).unwrap(),
            b"attachment"
        );
        assert_eq!(
            fs::read(new.join("EBWebView/Default/Local Storage/leveldb/prefs")).unwrap(),
            b"theme,wallpaper,user-id"
        );
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("workspace.json")).unwrap()).unwrap();
        assert_eq!(
            config["dataDirectory"],
            new.join("backend-data").to_string_lossy().as_ref()
        );
        assert_eq!(config["autoStart"], false);
        assert!(old.join("rust-backend.json").is_file());
        fs::write(new.join("backend-data/shellpilot.sqlite3"), b"new data").unwrap();
        migrate_root(&old, &new, &old, &new).unwrap();
        assert_eq!(
            fs::read(new.join("backend-data/shellpilot.sqlite3")).unwrap(),
            b"new data"
        );
    }

    #[test]
    fn preserves_external_custom_directory_and_retries_partial_staging() {
        let temporary = tempfile::tempdir().unwrap();
        let old = temporary.path().join(LEGACY_ID);
        let new = temporary.path().join(CURRENT_ID);
        fs::create_dir_all(&old).unwrap();
        let custom = temporary.path().join("custom-data");
        fs::write(
            old.join("rust-backend.json"),
            serde_json::to_vec(&serde_json::json!({"dataDirectory":custom})).unwrap(),
        )
        .unwrap();
        fs::create_dir_all(new.with_file_name(format!("{CURRENT_ID}.migration"))).unwrap();
        migrate_root(&old, &new, &old, &new).unwrap();
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("workspace.json")).unwrap()).unwrap();
        assert_eq!(config["dataDirectory"], custom.to_string_lossy().as_ref());
    }

    #[test]
    fn invalid_config_or_conflicting_destination_never_exposes_a_partial_workspace() {
        let temporary = tempfile::tempdir().unwrap();
        let old = temporary.path().join(LEGACY_ID);
        let new = temporary.path().join(CURRENT_ID);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("rust-backend.json"), b"invalid").unwrap();
        assert!(migrate_root(&old, &new, &old, &new).is_err());
        assert!(!new.exists());
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("keep"), b"existing").unwrap();
        assert!(migrate_root(&old, &new, &old, &new).is_err());
        assert_eq!(fs::read(new.join("keep")).unwrap(), b"existing");
        fs::write(new.join("workspace.json"), b"{}").unwrap();
        migrate_root(&old, &new, &old, &new).unwrap();
        assert_eq!(fs::read(new.join("keep")).unwrap(), b"existing");
    }
}

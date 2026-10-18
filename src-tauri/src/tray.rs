use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Window, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const OPEN: &str = "shellpilot-open";
const QUIT: &str = "shellpilot-quit";

pub(crate) fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let restore = || -> tauri::Result<()> {
        window.show()?;
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.set_focus()
    };
    if let Err(error) = restore() {
        eprintln!("恢复 ShellPilot 窗口失败: {error}");
    }
}

pub fn install(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, OPEN, "打开 ShellPilot", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("缺少 ShellPilot 托盘图标，无法启用关闭到托盘"))?;

    // Tauri retains the tray resource for the application's lifetime.
    TrayIconBuilder::with_id("shellpilot-main")
        .icon(icon)
        .tooltip("ShellPilot · 点击打开，右键退出")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => show_main_window(app),
            // Explicit exit bypasses CloseRequested. RunEvent::Exit cleans up
            // both the embedded workspace and all native local terminals.
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Native handling also covers the startup/settings screens and Alt+F4.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        // Hiding preserves the WebView, Agent tasks, SSH and SFTP sessions.
        if let Err(error) = window.hide() {
            eprintln!("隐藏 ShellPilot 到托盘失败: {error}");
        }
    }
}

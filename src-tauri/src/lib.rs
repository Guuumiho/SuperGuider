use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
struct ForegroundWindowSnapshot {
    app_name: String,
    process_name: String,
    window_title: String,
    source: String,
}

#[derive(Serialize)]
struct ScreenshotCaptureResult {
    status: String,
    reason: String,
    source: String,
}

#[tauri::command]
fn get_foreground_window_snapshot() -> ForegroundWindowSnapshot {
    platform_foreground_window_snapshot()
}

#[tauri::command]
fn capture_screenshot_snapshot() -> ScreenshotCaptureResult {
    // This reserves the command boundary for the screenshot pipeline.
    // Real capture will be added after foreground window and input signals are stable.
    ScreenshotCaptureResult {
        status: "not_implemented".to_string(),
        reason: "Screenshot capture command is wired, but real capture is not implemented yet."
            .to_string(),
        source: "rust_placeholder".to_string(),
    }
}

#[cfg(windows)]
fn platform_foreground_window_snapshot() -> ForegroundWindowSnapshot {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == HWND::default() {
            return fallback_snapshot("No foreground window", "windows_api_no_window");
        }

        let window_title = read_window_title(hwnd);
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));

        if process_id == 0 {
            return ForegroundWindowSnapshot {
                app_name: "Unknown App".to_string(),
                process_name: "unknown".to_string(),
                window_title,
                source: "windows_api_no_process_id".to_string(),
            };
        }

        let (process_name, app_name, source) = read_process_names(process_id);

        ForegroundWindowSnapshot {
            app_name,
            process_name,
            window_title,
            source,
        }
    }
}

#[cfg(not(windows))]
fn platform_foreground_window_snapshot() -> ForegroundWindowSnapshot {
    fallback_snapshot(
        "Foreground window reading is only implemented on Windows.",
        "unsupported_platform",
    )
}

#[cfg(windows)]
unsafe fn read_window_title(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};

    let title_len = GetWindowTextLengthW(hwnd);
    if title_len <= 0 {
        return "Untitled window".to_string();
    }

    let mut buffer = vec![0u16; title_len as usize + 1];
    let copied = GetWindowTextW(hwnd, &mut buffer);
    if copied <= 0 {
        return "Untitled window".to_string();
    }

    String::from_utf16_lossy(&buffer[..copied as usize])
}

#[cfg(windows)]
unsafe fn read_process_names(process_id: u32) -> (String, String, String) {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process_handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
        Ok(handle) => handle,
        Err(_) => {
            return (
                format!("pid:{process_id}"),
                "Unknown App".to_string(),
                "windows_api_open_process_failed".to_string(),
            );
        }
    };

    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let result = QueryFullProcessImageNameW(
        process_handle,
        PROCESS_NAME_WIN32,
        PWSTR(buffer.as_mut_ptr()),
        &mut size,
    );

    let _ = CloseHandle(process_handle);

    if result.is_err() || size == 0 {
        return (
            format!("pid:{process_id}"),
            "Unknown App".to_string(),
            "windows_api_process_name_failed".to_string(),
        );
    }

    let process_path = String::from_utf16_lossy(&buffer[..size as usize]);
    let process_name = Path::new(&process_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();
    let app_name = process_name.trim_end_matches(".exe").to_string();

    (process_name, app_name, "windows_api".to_string())
}

fn fallback_snapshot(window_title: &str, source: &str) -> ForegroundWindowSnapshot {
    ForegroundWindowSnapshot {
        app_name: "Unknown App".to_string(),
        process_name: "unknown".to_string(),
        window_title: window_title.to_string(),
        source: source.to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_foreground_window_snapshot,
            capture_screenshot_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

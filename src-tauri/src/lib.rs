use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::time::{SystemTime, UNIX_EPOCH};

// 这个文件是 Tauri/Rust 后端入口，负责所有浏览器前端不能直接做的本机能力：
// Windows 前台窗口读取、全局键盘监听、本机截图、SQLite/本机文件读写，以及 AI 接口请求。
// 前端通过 invoke("command_name") 调用下面这些 #[tauri::command] 函数。

#[derive(Clone, Serialize)]
struct GlobalInputEvent {
    event_type: String,
    source: String,
}

#[derive(Clone, Serialize)]
struct ForegroundWindowSnapshot {
    app_name: String,
    process_name: String,
    window_title: String,
    folder_path: Option<String>,
    source: String,
}

#[derive(Serialize)]
struct DetectedApp {
    app_name: String,
    process_name: String,
    source: String,
}

#[derive(Serialize)]
struct ScreenshotCaptureResult {
    status: String,
    reason: String,
    source: String,
    width: u32,
    height: u32,
    file_path: Option<String>,
    file_name: Option<String>,
}

#[derive(Deserialize)]
struct PersistedAppState {
    state_json: String,
}

#[derive(Deserialize)]
struct ActivityLogLine {
    line: String,
}

#[derive(Deserialize)]
struct ApiRequestLogLine {
    line: String,
}

#[derive(Deserialize)]
struct ActivityLogAnalysisUpdate {
    screenshot_label: String,
    analysis: String,
}

#[derive(Deserialize)]
struct AiAnalysisRequest {
    api_url: String,
    api_key: String,
    model: String,
    context_json: String,
    schema_json: String,
}

#[derive(Deserialize)]
struct ScreenshotAnalysisRequest {
    api_url: String,
    api_key: String,
    model: String,
    screenshot_path: String,
    context_json: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotAnalysisResult {
    summary: String,
    detail_text: String,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(default)]
struct PrivateSettings {
    api_url: String,
    api_key: String,
    screenshot_model: String,
    navigation_model: String,
    #[serde(default)]
    app_permissions: Vec<AppPermissionSetting>,
}

#[derive(Deserialize, Serialize)]
struct AppPermissionSetting {
    id: String,
    app_name: String,
    process_name: String,
    monitor_enabled: bool,
    user_confirmed: bool,
    discovery_source: String,
    discovered_at: String,
}

#[derive(Deserialize)]
struct AiPrivateSettingsUpdate {
    api_url: String,
    api_key: String,
    screenshot_model: String,
    navigation_model: String,
}

#[derive(Deserialize)]
struct AppPermissionsUpdate {
    app_permissions: Vec<AppPermissionSetting>,
}

#[tauri::command]
fn get_foreground_window_snapshot() -> ForegroundWindowSnapshot {
    platform_foreground_window_snapshot()
}

#[tauri::command]
fn capture_screenshot_snapshot() -> ScreenshotCaptureResult {
    platform_capture_screenshot_snapshot()
}

#[tauri::command]
fn scan_installed_apps() -> Vec<DetectedApp> {
    platform_scan_installed_apps()
}

#[tauri::command]
fn load_app_state() -> Result<Option<String>, String> {
    // 普通运行状态保存在 SQLite 中，只存任务、采样、队列等非私密运行态。
    // API Key 等私密配置不放这里，避免和 UI 状态一起被误覆盖。
    let connection = open_state_database()?;
    let mut statement = connection
        .prepare("SELECT state_json FROM app_state WHERE id = 1")
        .map_err(|error| error.to_string())?;
    let result = statement.query_row([], |row| row.get::<_, String>(0));

    match result {
        Ok(state_json) => Ok(Some(state_json)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_app_state(state: PersistedAppState) -> Result<(), String> {
    // 整个前端运行态用一行 JSON 保存。这个设计简单，适合当前 demo 阶段快速恢复页面状态。
    let connection = open_state_database()?;
    connection
        .execute(
            "INSERT INTO app_state (id, state_json, updated_at)
             VALUES (1, ?1, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
               state_json = excluded.state_json,
               updated_at = excluded.updated_at",
            params![state.state_json],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn append_activity_log_line(entry: ActivityLogLine) -> Result<(), String> {
    append_activity_log(&entry.line)
}

#[tauri::command]
fn update_activity_log_analysis(update: ActivityLogAnalysisUpdate) -> Result<(), String> {
    update_activity_log_screenshot_analysis(&update.screenshot_label, &update.analysis)
}

#[tauri::command]
fn get_activity_log_path() -> Result<String, String> {
    activity_log_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_activity_log() -> Result<String, String> {
    let path = activity_log_path()?;
    if !path.exists() {
        return Ok(String::new());
    }

    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn append_api_request_log_line(entry: ApiRequestLogLine) -> Result<(), String> {
    append_api_request_log(&entry.line)
}

#[tauri::command]
fn get_api_request_log_path() -> Result<String, String> {
    api_request_log_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_api_request_log() -> Result<String, String> {
    let path = api_request_log_path()?;
    if !path.exists() {
        return Ok(String::new());
    }

    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_private_settings() -> Result<Option<PrivateSettings>, String> {
    // 私密配置单独保存在 private-settings.json，包括 API Key、模型名和应用监控权限。
    // 这里返回 Option：首次启动文件不存在时，不算错误。
    let path = private_settings_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_private_settings(settings: PrivateSettings) -> Result<(), String> {
    // 兼容旧调用的整包保存入口。新 UI 已经尽量使用下面两个局部保存命令。
    write_private_settings(&settings)
}

#[tauri::command]
fn save_ai_private_settings(update: AiPrivateSettingsUpdate) -> Result<(), String> {
    // 只保存 API URL / API Key / 模型字段，保留磁盘上已有的 app_permissions。
    // 这样用户改 API 配置时，不会把应用监控列表覆盖掉。
    let mut settings = load_private_settings()?.unwrap_or_default();
    settings.api_url = update.api_url;
    settings.api_key = update.api_key;
    settings.screenshot_model = update.screenshot_model;
    settings.navigation_model = update.navigation_model;

    write_private_settings(&settings)
}

#[tauri::command]
fn save_app_permissions(update: AppPermissionsUpdate) -> Result<(), String> {
    // 只保存应用监控权限，保留磁盘上已有的 API URL / API Key / 模型字段。
    // 这是为了修复“点加入监控时把 API 配置清空”的风险。
    let mut settings = load_private_settings()?.unwrap_or_default();
    settings.app_permissions = update.app_permissions;

    write_private_settings(&settings)
}

fn write_private_settings(settings: &PrivateSettings) -> Result<(), String> {
    // 所有 private-settings 写入都走这里，保证目录创建和 JSON 格式化逻辑一致。
    let path = private_settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let raw = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

#[tauri::command]
async fn analyze_context_with_ai(request: AiAnalysisRequest) -> Result<String, String> {
    // 任务导航分析：输入是样本 JSON，输出应为符合 schema 的结构化 JSON。
    // 这条链路不看原图，主要看当前窗口、任务目标、截图摘要这些上下文。
    if request.api_url.trim().is_empty() {
        return Err("API URL 不能为空。".to_string());
    }

    if request.api_key.trim().is_empty() {
        return Err("API Key 不能为空。".to_string());
    }

    if request.model.trim().is_empty() {
        return Err("任务导航模型不能为空。".to_string());
    }

    let endpoint = chat_completions_endpoint(&request.api_url);
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(request.api_key)
        .json(&serde_json::json!({
            "model": request.model,
            "temperature": 0.2,
            "response_format": { "type": "json_object" },
            "messages": [
                {
                    "role": "system",
                    "content": "你是 SuperGuider 的低打扰任务引导分析器。必须只返回一个符合 schema 的 JSON 对象，不要 Markdown。JSON 字段名保持 schema 原样；body、basis、scenario、notify_type 等所有可读内容必须使用简体中文，用户看不懂英文。证据不足时 should_notify=false。"
                },
                {
                    "role": "user",
                    "content": format!(
                        "Schema:\n{}\n\n上下文：\n{}\n\n请判断现在是否需要提醒用户。证据不足时 should_notify=false。所有解释必须使用简体中文。",
                        request.schema_json,
                        request.context_json
                    )
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    let content_type = response_content_type(&response);
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        // 非 2xx 直接返回可读错误，尽量把状态码、Content-Type 和响应前缀带回来。
        return Err(format!(
            "任务分析请求失败，状态 {status}，Content-Type {content_type}：{}",
            response_body_preview(&body)
        ));
    }

    let value = parse_chat_completions_response("任务分析", status, &content_type, &body)?;
    value
        .pointer("/choices/0/message/content")
        .and_then(|content| content.as_str())
        .map(|content| content.to_string())
        .ok_or_else(|| "任务分析响应没有返回 choices[0].message.content。".to_string())
}

#[tauri::command]
async fn analyze_screenshot_with_ai(
    request: ScreenshotAnalysisRequest,
) -> Result<ScreenshotAnalysisResult, String> {
    // 截图理解分析：把本机截图转成 base64 image_url，交给兼容 chat completions 的视觉模型。
    // 成功后返回“摘要 + 详细转文字”，摘要用于当前 UI，详细文本为后续结构化抽取保留信息。
    if request.api_url.trim().is_empty() {
        return Err("API URL 不能为空。".to_string());
    }

    if request.api_key.trim().is_empty() {
        return Err("API Key 不能为空。".to_string());
    }

    if request.model.trim().is_empty() {
        return Err("截图理解模型不能为空。".to_string());
    }

    let image_bytes = fs::read(&request.screenshot_path).map_err(|error| error.to_string())?;
    let encoded_image = {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD.encode(image_bytes)
    };
    let mime_type = image_mime_type(&request.screenshot_path);
    let endpoint = chat_completions_endpoint(&request.api_url);
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(request.api_key)
        .json(&serde_json::json!({
            "model": request.model,
            "temperature": 0.2,
            "response_format": { "type": "json_object" },
            "messages": [
                {
                    "role": "system",
                    "content": "你是 SuperGuider 的截图理解模型。你必须只返回一个 JSON 对象，不要 Markdown，不要代码块，不要额外解释。字段必须是 summary 和 detailText。summary 用简体中文写 2-5 句摘要。detailText 用简体中文尽可能完整转写截图内容，不要丢信息：包括应用/窗口、页面结构、可见 UI 元素、按钮、列表、表格、图标含义、颜色/状态、文字内容、数字、错误提示、选中项、输入框内容，以及可能和用户任务有关的线索。看不清的内容标注“看不清”，不要凭空编造。"
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": format!(
                                "请分析这张截图，并严格返回 JSON：{{\"summary\":\"2-5句摘要\",\"detailText\":\"详细转文字版\"}}。detailText 要尽量保留所有可见信息，供后续程序抽取使用。上下文如下：\n{}",
                                request.context_json
                            )
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{mime_type};base64,{encoded_image}")
                            }
                        }
                    ]
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    let content_type = response_content_type(&response);
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        // 这里最常见的失败是 401、403 或网关返回 HTML/空文本，所以把原始响应前缀一起写进错误。
        return Err(format!(
            "截图分析请求失败，状态 {status}，Content-Type {content_type}：{}",
            response_body_preview(&body)
        ));
    }

    let value = parse_chat_completions_response("截图分析", status, &content_type, &body)?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|content| content.as_str())
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "截图分析响应没有返回 choices[0].message.content。".to_string())?;
    parse_screenshot_analysis_content(&content)
}

fn parse_screenshot_analysis_content(content: &str) -> Result<ScreenshotAnalysisResult, String> {
    // 视觉模型必须返回结构化 JSON。这里做一次强校验，避免把“只有摘要的纯文本”继续传下去。
    let result: ScreenshotAnalysisResult = serde_json::from_str(content).map_err(|error| {
        format!(
            "截图分析响应不是预期 JSON，无法同时取得摘要和详细转文字：{error}。响应开头：{}",
            response_body_preview(content)
        )
    })?;

    if result.summary.trim().is_empty() {
        return Err("截图分析响应缺少 summary 摘要。".to_string());
    }

    if result.detail_text.trim().is_empty() {
        return Err("截图分析响应缺少 detailText 详细转文字。".to_string());
    }

    Ok(ScreenshotAnalysisResult {
        summary: result.summary.trim().to_string(),
        detail_text: result.detail_text.trim().to_string(),
    })
}

fn response_content_type(response: &reqwest::Response) -> String {
    // 响应头里的 Content-Type 对排错很关键：application/json、text/html、空值代表完全不同的问题。
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("未返回 Content-Type")
        .to_string()
}

fn parse_chat_completions_response(
    label: &str,
    status: reqwest::StatusCode,
    content_type: &str,
    body: &str,
) -> Result<serde_json::Value, String> {
    // 兼容 OpenAI Chat Completions 的 JSON 解析。
    // 如果服务端返回 HTML、纯文本、空字符串，这里会直接报错并带上响应预览。
    if body.trim().is_empty() {
        return Err(format!(
            "{label}响应为空，状态 {status}，Content-Type {content_type}。请检查 API URL 是否指向 OpenAI 兼容的 chat completions 接口。"
        ));
    }

    serde_json::from_str(body).map_err(|error| {
        format!(
            "{label}响应不是 OpenAI 兼容 JSON：{error}；状态 {status}，Content-Type {content_type}；响应开头：{}",
            response_body_preview(body)
        )
    })
}

fn response_body_preview(body: &str) -> String {
    // 错误日志只保留前一小段响应，避免把大块 HTML 或无意义内容刷进日志。
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview: String = compact.chars().take(360).collect();
    if preview.is_empty() {
        "空响应".to_string()
    } else if compact.chars().count() > 360 {
        format!("{preview}...")
    } else {
        preview
    }
}

fn image_mime_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn chat_completions_endpoint(api_url: &str) -> String {
    // 统一把“接口根路径”拼成 /chat/completions。
    // 用户可以填根路径，也可以直接填完整路径；这里自动兼容两种写法。
    let trimmed = api_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn open_state_database() -> Result<Connection, String> {
    // SQLite 只存非私密运行态。目录会在这里自动创建。
    let database_path = state_database_path()?;
    if let Some(parent) = database_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS app_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              state_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|error| error.to_string())?;

    Ok(connection)
}

fn state_database_path() -> Result<PathBuf, String> {
    superguider_data_dir().map(|path| path.join("superguider.sqlite3"))
}

fn private_settings_path() -> Result<PathBuf, String> {
    superguider_data_dir().map(|path| path.join("private-settings.json"))
}

fn activity_log_path() -> Result<PathBuf, String> {
    // 活动日志：人类可读的时间线，记录切换、截图、分析回写。
    superguider_data_dir().map(|path| path.join("activity-log.md"))
}

fn api_request_log_path() -> Result<PathBuf, String> {
    // API 请求日志：专门给你排查网络、模型、网关、响应格式问题。
    superguider_data_dir().map(|path| path.join("api-request-log.md"))
}

fn screenshots_dir() -> Result<PathBuf, String> {
    superguider_data_dir().map(|path| path.join("screenshots"))
}

fn append_activity_log(line: &str) -> Result<(), String> {
    // 活动日志是“最终事实链”，只追加不覆盖；首写时自动补 header。
    let path = activity_log_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let should_write_header = !path.exists()
        || fs::metadata(&path)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;

    if should_write_header {
        writeln!(
            file,
            "# SuperGuider 活动日志\n\n格式：时间，应用，窗口，截图，内容\n"
        )
        .map_err(|error| error.to_string())?;
    }

    writeln!(file, "{}", normalize_activity_log_line(line)).map_err(|error| error.to_string())
}

fn normalize_activity_log_line(line: &str) -> String {
    // 后端兜底：旧前端可能还会传入 `HH:mm:ss，应用，窗口`。
    // activity-log.md 必须有完整日期，详情页的“今天/时间范围”过滤才可靠。
    if starts_with_clock_only_activity_time(line) {
        format!("{} {line}", local_date_label())
    } else {
        line.to_string()
    }
}

fn starts_with_clock_only_activity_time(line: &str) -> bool {
    let mut chars = line.chars();
    let pattern = [
        true, true, false, true, true, false, true, true, false,
    ];

    for expects_digit in pattern {
        let Some(character) = chars.next() else {
            return false;
        };

        if expects_digit {
            if !character.is_ascii_digit() {
                return false;
            }
        } else if character != ':' {
            return false;
        }
    }

    matches!(chars.next(), Some('，'))
}

#[cfg(windows)]
fn local_date_label() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;

    unsafe {
        let time = GetLocalTime();
        format!("{:04}-{:02}-{:02}", time.wYear, time.wMonth, time.wDay)
    }
}

#[cfg(not(windows))]
fn local_date_label() -> String {
    "1970-01-01".to_string()
}

fn append_api_request_log(line: &str) -> Result<(), String> {
    // API 请求日志也是只追加不覆盖，方便保留最近每一次请求/重试/失败原因。
    let path = api_request_log_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let should_write_header = !path.exists()
        || fs::metadata(&path)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;

    if should_write_header {
        writeln!(
            file,
            "# SuperGuider API 请求日志\n\n格式：时间，阶段，样本，模型，接口，状态，说明\n"
        )
        .map_err(|error| error.to_string())?;
    }

    writeln!(file, "{line}").map_err(|error| error.to_string())
}

fn update_activity_log_screenshot_analysis(
    screenshot_label: &str,
    analysis: &str,
) -> Result<(), String> {
    // 把“截图分析待重试/已分析/任务分析待分析”回写到活动日志对应行。
    // 这样活动日志会从“截图已进入队列”更新成“现在卡在哪一步”。
    let path = activity_log_path()?;
    if !path.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut changed = false;
    let next = raw
        .lines()
        .map(|line| {
            if line.contains(screenshot_label)
                && (line.contains("，内容 ") || line.contains("，分析 "))
            {
                changed = true;
                let prefix = line
                    .split_once("，内容 ")
                    .or_else(|| line.split_once("，分析 "))
                    .map(|(prefix, _)| prefix)
                    .unwrap_or(line);
                format!("{prefix}，内容 {analysis}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    if changed {
        fs::write(path, format!("{next}\n")).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn superguider_data_dir() -> Result<PathBuf, String> {
    // SuperGuider 所有本机数据统一放在 LOCALAPPDATA，便于用户自己检查和备份。
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(path).join("SuperGuider"));
    }

    std::env::current_dir()
        .map(|path| path.join("data"))
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn platform_scan_installed_apps() -> Vec<DetectedApp> {
    // 扫描桌面快捷方式和任务栏固定项，作为“应用监控范围”的初始候选列表。
    // 运行过程中发现的新前台应用还会由前端动态补入待确认列表。
    let mut apps = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();

    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        roots.push((
            PathBuf::from(program_data).join("Desktop"),
            "public_desktop",
        ));
    }

    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        roots.push((PathBuf::from(user_profile).join("Desktop"), "user_desktop"));
    }

    if let Some(home_drive) = std::env::var_os("HOMEDRIVE") {
        if let Some(home_path) = std::env::var_os("HOMEPATH") {
            roots.push((
                PathBuf::from(format!(
                    "{}{}\\Desktop",
                    home_drive.to_string_lossy(),
                    home_path.to_string_lossy()
                )),
                "user_desktop",
            ));
        }
    }

    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push((
            PathBuf::from(app_data)
                .join("Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"),
            "taskbar_pinned",
        ));
    }

    for (root, source) in roots {
        collect_shortcut_apps(&root, source, &mut apps, &mut seen);
    }

    apps.sort_by(|left, right| {
        left.app_name
            .to_lowercase()
            .cmp(&right.app_name.to_lowercase())
    });
    apps
}

#[cfg(not(windows))]
fn platform_scan_installed_apps() -> Vec<DetectedApp> {
    Vec::new()
}

#[cfg(windows)]
fn collect_shortcut_apps(
    directory: &Path,
    source: &str,
    apps: &mut Vec<DetectedApp>,
    seen: &mut std::collections::HashSet<String>,
) {
    // 递归收集 .lnk 和 .exe。lnk 会解析到目标 exe，从而得到稳定的 process_name。
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_shortcut_apps(&path, source, apps, seen);
            continue;
        }

        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(extension.as_str(), "lnk" | "exe") {
            continue;
        }

        let target_path = if extension == "lnk" {
            resolve_shortcut_target(&path)
        } else {
            Some(path.clone())
        };
        let process_name = target_path
            .as_ref()
            .and_then(|target| target.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        let app_name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Unknown App")
            .trim()
            .to_string();
        if app_name.is_empty() {
            continue;
        }

        let key = if process_name.is_empty() {
            app_name.to_lowercase()
        } else {
            process_name.to_lowercase()
        };
        if !seen.insert(key) {
            continue;
        }

        apps.push(DetectedApp {
            app_name,
            process_name,
            source: source.to_string(),
        });
    }
}

#[cfg(windows)]
fn resolve_shortcut_target(shortcut_path: &Path) -> Option<PathBuf> {
    // Windows 快捷方式解析必须走 COM 的 IShellLinkW。
    // 失败时返回 None，不阻塞应用启动。
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| {
            let shell_link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist_file: IPersistFile = shell_link.cast().ok()?;
            let shortcut_wide = path_to_wide(shortcut_path);
            persist_file
                .Load(PCWSTR(shortcut_wide.as_ptr()), STGM(0))
                .ok()?;

            let mut target_buffer = vec![0u16; 32768];
            let mut find_data = WIN32_FIND_DATAW::default();
            shell_link
                .GetPath(&mut target_buffer, &mut find_data, SLGP_RAWPATH.0 as u32)
                .ok()?;

            let end = target_buffer
                .iter()
                .position(|character| *character == 0)
                .unwrap_or(target_buffer.len());
            if end == 0 {
                return None;
            }

            Some(PathBuf::from(String::from_utf16_lossy(
                &target_buffer[..end],
            )))
        })();

        if initialized {
            CoUninitialize();
        }

        result
    }
}

#[cfg(windows)]
fn path_to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn platform_foreground_window_snapshot() -> ForegroundWindowSnapshot {
    // 读取当前前台窗口：窗口标题、进程名、应用名，以及 Explorer 文件夹路径。
    // 前端会用这些信息做去重、权限判断和活动日志展示。
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

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
                folder_path: None,
                source: "windows_api_no_process_id".to_string(),
            };
        }

        let (process_name, app_name, source) = read_process_names(process_id);
        let folder_path = if process_name.eq_ignore_ascii_case("explorer.exe") {
            read_explorer_folder_path(hwnd)
        } else {
            None
        };

        ForegroundWindowSnapshot {
            app_name,
            process_name,
            window_title,
            folder_path,
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
fn platform_capture_screenshot_snapshot() -> ScreenshotCaptureResult {
    // 使用 Windows GDI 截整屏，并保存为 PNG。
    // 截图结果只返回文件路径/文件名，不把图片二进制塞回前端状态。
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
        GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetDesktopWindow, GetWindowRect};

    let snapshot = platform_foreground_window_snapshot();

    unsafe {
        let desktop_window = GetDesktopWindow();
        let mut rect = RECT::default();
        if GetWindowRect(desktop_window, &mut rect).is_err() {
            return screenshot_result(
                "failed",
                "Could not read desktop bounds.",
                "windows_gdi_get_window_rect_failed",
                0,
                0,
                None,
            );
        }

        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        if width == 0 || height == 0 {
            return screenshot_result(
                "failed",
                "Desktop bounds are empty.",
                "windows_gdi_empty_bounds",
                width,
                height,
                None,
            );
        }

        let screen_dc = GetWindowDC(None);
        if screen_dc.is_invalid() {
            return screenshot_result(
                "failed",
                "Could not acquire screen device context.",
                "windows_gdi_get_dc_failed",
                width,
                height,
                None,
            );
        }

        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        if memory_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return screenshot_result(
                "failed",
                "Could not create compatible memory device context.",
                "windows_gdi_create_dc_failed",
                width,
                height,
                None,
            );
        }

        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.is_invalid() {
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(None, screen_dc);
            return screenshot_result(
                "failed",
                "Could not create compatible bitmap.",
                "windows_gdi_create_bitmap_failed",
                width,
                height,
                None,
            );
        }

        let previous_object = SelectObject(memory_dc, bitmap.into());
        let copied = BitBlt(
            memory_dc,
            0,
            0,
            width as i32,
            height as i32,
            Some(screen_dc),
            rect.left,
            rect.top,
            SRCCOPY,
        );

        if copied.is_err() {
            let _ = SelectObject(memory_dc, previous_object);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(None, screen_dc);
            return screenshot_result(
                "failed",
                "Screen pixels could not be copied into memory.",
                "windows_gdi_bitblt_failed",
                width,
                height,
                None,
            );
        }

        let bytes_per_pixel = 4usize;
        let mut pixels = vec![0u8; width as usize * height as usize * bytes_per_pixel];
        let mut bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: pixels.len() as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: Default::default(),
        };
        let lines_read = GetDIBits(
            memory_dc,
            bitmap,
            0,
            height,
            Some(pixels.as_mut_ptr().cast()),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        );

        let _ = SelectObject(memory_dc, previous_object);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(None, screen_dc);

        if lines_read == 0 {
            return screenshot_result(
                "failed",
                "Screen pixels could not be converted for saving.",
                "windows_gdi_get_dibits_failed",
                width,
                height,
                None,
            );
        }

        match save_png_screenshot(width, height, &pixels, &snapshot) {
            Ok(path) => {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.to_string());
                screenshot_result(
                    "captured",
                    "Screenshot was captured and saved to disk.",
                    "windows_gdi_saved_png",
                    width,
                    height,
                    Some((path.to_string_lossy().to_string(), file_name)),
                )
            }
            Err(error) => screenshot_result(
                "failed",
                &format!("Screenshot captured but could not be saved: {error}"),
                "windows_gdi_save_failed",
                width,
                height,
                None,
            ),
        }
    }
}

#[cfg(not(windows))]
fn platform_capture_screenshot_snapshot() -> ScreenshotCaptureResult {
    screenshot_result(
        "unsupported",
        "Screenshot capture is only implemented on Windows.",
        "unsupported_platform",
        0,
        0,
        None,
    )
}

fn save_png_screenshot(
    width: u32,
    height: u32,
    pixels: &[u8],
    snapshot: &ForegroundWindowSnapshot,
) -> Result<PathBuf, String> {
    // 截图文件统一放在 %LOCALAPPDATA%\SuperGuider\screenshots。
    // 文件名按“时间_应用_窗口”组织，文件夹按名称排序时自然就是时间顺序。
    let directory = screenshots_dir()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let file_name = screenshot_file_name(snapshot);
    let path = directory.join(file_name);
    write_png_file(&path, width, height, pixels)?;
    Ok(path)
}

fn screenshot_file_name(snapshot: &ForegroundWindowSnapshot) -> String {
    // 根据前台窗口生成可读文件名。时间放最前面，应用和窗口放后面便于人眼识别。
    let app_name = sanitize_file_name_part(&snapshot.app_name, "unknown-app", 48);
    let window_title = sanitize_file_name_part(&snapshot.window_title, "", 88);
    let timestamp = local_timestamp_label();

    if window_title.is_empty() {
        format!("{timestamp}_{app_name}.png")
    } else {
        format!("{timestamp}_{app_name}_{window_title}.png")
    }
}

fn sanitize_file_name_part(value: &str, fallback: &str, max_chars: usize) -> String {
    // Windows 文件名不能包含 < > : " / \ | ? * 等字符，这里统一替换成下划线。
    let mut sanitized = String::new();
    let trimmed = value.trim();

    for character in trimmed.chars() {
        let next = match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character if character.is_whitespace() => '_',
            character => character,
        };
        sanitized.push(next);
    }

    let sanitized = sanitized
        .trim_matches(|character| character == '_' || character == '.')
        .to_string();
    let sanitized = if sanitized.eq_ignore_ascii_case("Untitled window") {
        String::new()
    } else {
        sanitized
    };
    let sanitized = if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    };

    sanitized.chars().take(max_chars).collect()
}

#[cfg(windows)]
fn local_timestamp_label() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;

    unsafe {
        let time = GetLocalTime();
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}-{:03}",
            time.wYear,
            time.wMonth,
            time.wDay,
            time.wHour,
            time.wMinute,
            time.wSecond,
            time.wMilliseconds
        )
    }
}

#[cfg(not(windows))]
fn local_timestamp_label() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "unknown-time".to_string())
}

fn write_png_file(path: &Path, width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
    // GDI 读出的像素是 BGRA，这里转成 PNG 需要的 RGBA。
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(&mut file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut rgba_pixels = Vec::with_capacity(pixels.len());
    for pixel in pixels.chunks_exact(4) {
        rgba_pixels.push(pixel[2]);
        rgba_pixels.push(pixel[1]);
        rgba_pixels.push(pixel[0]);
        rgba_pixels.push(255);
    }

    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(&rgba_pixels)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
unsafe fn read_window_title(hwnd: windows::Win32::Foundation::HWND) -> String {
    // 读取窗口标题。读不到时返回 Untitled window，前端会再做中文展示和过滤。
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
    // 根据进程 ID 读取 exe 文件名。app_name 默认去掉 .exe，process_name 保留完整进程名。
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
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

#[cfg(windows)]
unsafe fn read_explorer_folder_path(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    // Explorer 的窗口标题经常不稳定，所以额外用 ShellWindows 找到当前文件夹真实路径。
    use windows::core::Interface;
    use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Shell::{IShellWindows, IWebBrowserApp, ShellWindows};

    let init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    let should_uninitialize = init_result == S_OK || init_result == S_FALSE;
    if init_result.is_err() && init_result != RPC_E_CHANGED_MODE {
        return None;
    }

    let mut folder_path = None;
    if let Ok(shell_windows) = CoCreateInstance::<_, IShellWindows>(&ShellWindows, None, CLSCTX_ALL)
    {
        if let Ok(count) = shell_windows.Count() {
            for index in 0..count {
                let variant = VARIANT {
                    Anonymous: VARIANT_0 {
                        Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                            vt: VT_I4,
                            wReserved1: 0,
                            wReserved2: 0,
                            wReserved3: 0,
                            Anonymous: VARIANT_0_0_0 { lVal: index },
                        }),
                    },
                };

                let Ok(dispatch) = shell_windows.Item(&variant) else {
                    continue;
                };
                let Ok(browser) = dispatch.cast::<IWebBrowserApp>() else {
                    continue;
                };
                let Ok(shell_hwnd) = browser.HWND() else {
                    continue;
                };
                if shell_hwnd.0 != hwnd.0 as isize {
                    continue;
                }

                folder_path = browser
                    .LocationURL()
                    .ok()
                    .and_then(|url| file_url_to_windows_path(&url.to_string()));
                break;
            }
        }
    }

    if should_uninitialize {
        CoUninitialize();
    }

    folder_path
}

#[cfg(windows)]
fn file_url_to_windows_path(url: &str) -> Option<String> {
    // ShellWindows 返回 file:///C:/xxx 形式，这里转成 Windows 路径 C:\xxx。
    let raw_path = url
        .strip_prefix("file:///")
        .or_else(|| url.strip_prefix("file://"))?;
    let decoded = percent_decode_utf8(raw_path)?;
    let path = if decoded.starts_with('/') {
        format!(r"\{}", decoded.trim_start_matches('/').replace('/', r"\"))
    } else {
        decoded.replace('/', r"\")
    };
    let trimmed = path.trim();

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(windows)]
fn percent_decode_utf8(value: &str) -> Option<String> {
    // Explorer URL 里中文路径会百分号编码，这里做最小 UTF-8 解码。
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_digit(bytes[index + 1])?;
            let low = hex_digit(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded).ok()
}

#[cfg(windows)]
fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn fallback_snapshot(window_title: &str, source: &str) -> ForegroundWindowSnapshot {
    // 所有无法读取前台窗口的情况都返回统一结构，前端就不用处理 null。
    ForegroundWindowSnapshot {
        app_name: "Unknown App".to_string(),
        process_name: "unknown".to_string(),
        window_title: window_title.to_string(),
        folder_path: None,
        source: source.to_string(),
    }
}

fn screenshot_result(
    status: &str,
    reason: &str,
    source: &str,
    width: u32,
    height: u32,
    saved_file: Option<(String, Option<String>)>,
) -> ScreenshotCaptureResult {
    // 截图命令统一返回这个结构；失败也有 status/reason，前端可以直接展示。
    let (file_path, file_name) = saved_file.unwrap_or((String::new(), None));
    ScreenshotCaptureResult {
        status: status.to_string(),
        reason: reason.to_string(),
        source: source.to_string(),
        width,
        height,
        file_path: if file_path.is_empty() {
            None
        } else {
            Some(file_path)
        },
        file_name,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tauri 应用启动入口：
    // setup 里启动后台监听线程；invoke_handler 注册前端可以调用的本机命令。
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            start_global_input_listener(app.handle().clone());
            start_foreground_window_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_foreground_window_snapshot,
            capture_screenshot_snapshot,
            scan_installed_apps,
            load_app_state,
            save_app_state,
            append_activity_log_line,
            update_activity_log_analysis,
            get_activity_log_path,
            load_activity_log,
            append_api_request_log_line,
            get_api_request_log_path,
            load_api_request_log,
            load_private_settings,
            save_private_settings,
            save_ai_private_settings,
            save_app_permissions,
            analyze_context_with_ai,
            analyze_screenshot_with_ai
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(windows)]
fn start_global_input_listener(app_handle: tauri::AppHandle) {
    // 全局键盘监听：捕获 Enter、Ctrl+C 和 Alt+Tab 时段。
    // hook 回调只负责发事件，不做截图和网络请求，避免阻塞系统输入。
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_MENU, VK_RCONTROL, VK_RETURN,
        VK_RMENU, VK_TAB,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static GLOBAL_INPUT_SENDER: OnceLock<mpsc::Sender<GlobalInputEvent>> = OnceLock::new();

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // 低级键盘 hook 运行在系统回调里，必须尽量短小。
        // 真正的采样逻辑交给 React 前端统一处理。
        let message = wparam.0 as u32;
        let is_key_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let is_key_up = message == WM_KEYUP || message == WM_SYSKEYUP;

        if code >= 0 && (is_key_down || is_key_up) {
            let keyboard = *(lparam.0 as *const KBDLLHOOKSTRUCT);
            let event_type = if is_key_down && keyboard.vkCode == VK_RETURN.0 as u32 {
                Some("enter")
            } else if is_key_down && keyboard.vkCode == b'C' as u32 && is_control_pressed() {
                Some("screenshot")
            } else if is_key_down && keyboard.vkCode == VK_TAB.0 as u32 && is_alt_pressed() {
                Some("alt_tab_pulse")
            } else if is_key_up && is_alt_key(keyboard.vkCode) {
                Some("alt_tab_end")
            } else {
                None
            };

            if let (Some(event_type), Some(sender)) = (event_type, GLOBAL_INPUT_SENDER.get()) {
                let _ = sender.send(GlobalInputEvent {
                    event_type: event_type.to_string(),
                    source: "windows_global_keyboard_hook".to_string(),
                });
            }
        }

        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe fn is_control_pressed() -> bool {
        const KEY_PRESSED_MASK: i16 = i16::MIN;
        GetAsyncKeyState(VK_CONTROL.0 as i32) & KEY_PRESSED_MASK != 0
            || GetAsyncKeyState(VK_LCONTROL.0 as i32) & KEY_PRESSED_MASK != 0
            || GetAsyncKeyState(VK_RCONTROL.0 as i32) & KEY_PRESSED_MASK != 0
    }

    unsafe fn is_alt_pressed() -> bool {
        const KEY_PRESSED_MASK: i16 = i16::MIN;
        GetAsyncKeyState(VK_MENU.0 as i32) & KEY_PRESSED_MASK != 0
            || GetAsyncKeyState(VK_LMENU.0 as i32) & KEY_PRESSED_MASK != 0
            || GetAsyncKeyState(VK_RMENU.0 as i32) & KEY_PRESSED_MASK != 0
    }

    fn is_alt_key(vk_code: u32) -> bool {
        vk_code == VK_MENU.0 as u32 || vk_code == VK_LMENU.0 as u32 || vk_code == VK_RMENU.0 as u32
    }

    let (sender, receiver) = mpsc::channel::<GlobalInputEvent>();
    let _ = GLOBAL_INPUT_SENDER.set(sender);

    std::thread::spawn(move || {
        use tauri::Emitter;

        // channel 接到事件后转发给前端，前端监听 superguider://global-input。
        for event in receiver {
            let _ = app_handle.emit("superguider://global-input", event);
        }
    });

    std::thread::spawn(move || unsafe {
        // 安装 Windows 低级键盘 hook，并用消息循环保持 hook 存活。
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0) {
            Ok(hook) => hook,
            Err(_) => return,
        };

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {}

        let _ = hook;
    });
}

#[cfg(not(windows))]
fn start_global_input_listener(_app_handle: tauri::AppHandle) {}

#[cfg(windows)]
fn start_foreground_window_listener(app_handle: tauri::AppHandle) {
    // 前台窗口监听：Windows 触发 EVENT_SYSTEM_FOREGROUND 时读取一次前台窗口快照。
    // 前端收到事件后再做去重、权限检查和 3 秒稳定截图。
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMessageW, EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT,
    };

    static FOREGROUND_WINDOW_SENDER: OnceLock<mpsc::Sender<ForegroundWindowSnapshot>> =
        OnceLock::new();

    unsafe extern "system" fn foreground_event_hook(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        // 只处理前台窗口事件。hwnd 无效时忽略，避免产生无意义活动记录。
        if event != EVENT_SYSTEM_FOREGROUND || hwnd == HWND::default() {
            return;
        }

        if let Some(sender) = FOREGROUND_WINDOW_SENDER.get() {
            let _ = sender.send(platform_foreground_window_snapshot());
        }
    }

    let (sender, receiver) = mpsc::channel::<ForegroundWindowSnapshot>();
    let _ = FOREGROUND_WINDOW_SENDER.set(sender);

    std::thread::spawn(move || {
        use tauri::Emitter;

        // 后台线程把 Windows 前台窗口快照转成 Tauri 事件。
        for snapshot in receiver {
            let _ = app_handle.emit("superguider://foreground-window", snapshot);
        }
    });

    std::thread::spawn(move || unsafe {
        // 注册 WinEventHook，并用消息循环保持监听活着。
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_event_hook),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_invalid() {
            return;
        }

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {}

        let _ = hook;
    });
}

#[cfg(not(windows))]
fn start_foreground_window_listener(_app_handle: tauri::AppHandle) {}

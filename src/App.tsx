import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  analysisResultSchema,
  type AnalysisResult,
  type NotifyButton,
  validateAnalysisResult,
} from "./aiContract";
import "./App.css";

type Page = "status" | "details" | "settings";
type AppMode = "silent_companion" | "task_tracking";

// 用户当前追踪的任务。deadline 用 datetime-local 字符串保存，便于表单原样回填。
type Task = {
  goal: string;
  deadline: string;
  notes: string;
  startedAt?: string;
};

// 启动任务后展示的参考拆解。现在还是本地 mock，但字段保持接近真实 AI 输出。
type ReferenceStage = {
  stage_id: string;
  stage_title: string;
  stage_goal: string;
  minimum_estimated_minutes: number;
};

type ReferencePlan = {
  scenario: string;
  should_notify: boolean;
  body: string;
  reference_stages: ReferenceStage[];
};

type NotificationScenario = {
  scenario: string;
  should_notify: boolean;
  notify_type: string;
  body: string;
  button: NotifyButton;
};

type TaskSummary = {
  scenario: string;
  should_notify: boolean;
  summary_text: string;
  time_breakdown: Array<{
    topic: string;
    duration_minutes: number;
  }>;
  final_observation: string;
};

type NotificationRecord = {
  scenario: string;
  notifyType: string;
  body: string;
  result: "shown" | "auto_dismissed" | "correction_clicked" | "not_shown";
  correction?: string;
  recordedAt: string;
};

type InputEventRecord = {
  eventType: "enter" | "screenshot";
  recordedAt: string;
  source: "frontend_window" | "windows_global_keyboard_hook";
};

type GlobalInputEventType =
  | InputEventRecord["eventType"]
  | "alt_tab_pulse"
  | "alt_tab_end";

type GlobalInputEvent = {
  event_type: GlobalInputEventType;
  source: InputEventRecord["source"];
};

// 这份设置会被拆成两个保存区：API/模型字段单独保存，应用监控权限单独保存。
// 这样用户改应用监控时，不会把 API URL/API Key/模型误覆盖成空值。
type Settings = {
  apiUrl: string;
  screenshotModel: string;
  navigationModel: string;
  appPermissions: AppPermission[];
};

type AiAnalysisRequest = {
  api_url: string;
  api_key: string;
  model: string;
  context_json: string;
  schema_json: string;
};

type ScreenshotAnalysisRequest = {
  api_url: string;
  api_key: string;
  model: string;
  screenshot_path: string;
  context_json: string;
};

type ScreenshotAnalysisResult = {
  summary: string;
  detailText: string;
};

type PrivateSettings = {
  api_url: string;
  api_key: string;
  screenshot_model: string;
  navigation_model: string;
  app_permissions?: AppPermission[];
};

type SettingsSaveStatus = "idle" | "saving" | "saved" | "error";
type AiSettingsSaveStatus = SettingsSaveStatus;
type AppPermissionsSaveStatus = SettingsSaveStatus;

type DetectedApp = {
  app_name: string;
  process_name: string;
  source: string;
};

type AppPermission = {
  id: string;
  app_name: string;
  process_name: string;
  monitor_enabled: boolean;
  user_confirmed: boolean;
  discovery_source: string;
  discovered_at: string;
};

type StoredAppState = {
  task: Task | null;
  notificationRecords: NotificationRecord[];
  inputEventRecords: InputEventRecord[];
  activityLogRecords: ActivityLogRecord[];
  requestQueues: RequestQueues;
  contextSamples: ContextSampleRecord[];
  analysisResults: AnalysisResult[];
  summary: TaskSummary | null;
};

type ForegroundWindowSnapshot = {
  app_name: string;
  process_name: string;
  window_title: string;
  folder_path?: string | null;
  source: string;
};

type ScreenshotCaptureResult = {
  status: string;
  reason: string;
  source: string;
  width: number;
  height: number;
  file_path: string | null;
  file_name: string | null;
};

type ActivityLogRecord = {
  eventType: "switch" | "screenshot" | "analysis";
  sampleId?: string;
  recordedAt: string;
  appName?: string;
  processName?: string;
  windowTitle?: string;
  screenshotPath?: string;
  screenshotFileName?: string;
  status?: string;
  screenshotAnalysis?: string;
  screenshotDetailText?: string;
  analysisBody?: string;
};

type AnalysisStatus = "pending" | "retrying" | "analyzed" | "failed";

// 截图理解队列：截图先排到这里，成功拿到截图摘要和详细转文字以后才会进入任务分析队列。
type ScreenshotAnalysisQueueItem = {
  id: string;
  sampleId: string;
  dueAt: number;
  attempts: number;
  lastError?: string;
};

// 任务分析队列：依赖截图分析结果，把截图摘要、详细转文字、窗口信息、任务目标合并后请求导航模型。
type TaskAnalysisQueueItem = {
  id: string;
  sampleId: string;
  dueAt: number;
  attempts: number;
  lastError?: string;
};

type RequestQueues = {
  screenshotAnalysis: ScreenshotAnalysisQueueItem[];
  taskAnalysis: TaskAnalysisQueueItem[];
};

type AnalysisWorkKind = "screenshot" | "task";

type QueuePauseState = {
  screenshot: boolean;
  task: boolean;
};

type QueueRetryState = Record<
  AnalysisWorkKind,
  {
    failureCount: number;
    pausedUntil: number | null;
    lastFailedItemId?: string;
    lastError?: string;
  }
>;

// 当前正在请求的队列项。它不持久化，只用于详情页显示“现在到底在跑哪一张截图/哪一次任务分析”。
type ActiveAnalysisWork = {
  kind: AnalysisWorkKind;
  sampleId: string;
  queueItemId: string;
  startedAt: string;
  attempts: number;
  model: string;
  endpoint: string;
  screenshotFileName?: string;
};

type ContextSampleTrigger =
  | "manual_button"
  | "foreground_switch"
  | "interval_fallback"
  | InputEventRecord["source"];

type ActivityLogTableRow = {
  id: string;
  time: string;
  app: string;
  displayApp: string;
  rawApp: string;
  rawWindowTitle: string;
  windowTitle: string;
  screenshot: string;
  content: string;
  appBreak: boolean;
  muted: boolean;
  timestampMs?: number;
};

type ContextSampleRecord = {
  id: string;
  recordedAt: string;
  trigger: ContextSampleTrigger;
  taskGoal: string;
  window: ForegroundWindowSnapshot | null;
  screenshot: ScreenshotCaptureResult | null;
  screenshotAnalysisStatus?: AnalysisStatus;
  taskAnalysisStatus?: AnalysisStatus;
  screenshotAnalysis?: string;
  screenshotDetailText?: string;
  error?: string;
};

const storageKey = "superguider-demo-state";

const defaultSettings: Settings = {
  apiUrl: "",
  screenshotModel: "",
  navigationModel: "",
  appPermissions: [],
};

const defaultStoredState: StoredAppState = {
  task: null,
  notificationRecords: [],
  inputEventRecords: [],
  activityLogRecords: [],
  requestQueues: {
    screenshotAnalysis: [],
    taskAnalysis: [],
  },
  contextSamples: [],
  analysisResults: [],
  summary: null,
};

const foregroundStableScreenshotDelayMs = 3000;
const maximumScreenshotIntervalMs = 3 * 60 * 1000;
const screenshotIntervalCheckMs = 30 * 1000;
const altTabPostEndSuppressMs = 1200;
const altTabWatchdogMs = 2500;

function appPermissionId(app: Pick<AppPermission, "app_name" | "process_name">) {
  const processName = app.process_name.trim().toLowerCase();
  if (processName) {
    return `process:${processName}`;
  }

  return `app:${app.app_name.trim().toLowerCase()}`;
}

function normalizeAppPermissionRecord(permission: AppPermission): AppPermission {
  const appName =
    permission.app_name.trim() || permission.process_name.trim() || "未知应用";
  const processName = permission.process_name.trim();
  return {
    ...permission,
    id: appPermissionId({ app_name: appName, process_name: processName }),
    app_name: appName,
    process_name: processName,
  };
}

function createAppPermission(
  app: DetectedApp,
  userConfirmed: boolean,
): AppPermission {
  const basePermission = {
    app_name: app.app_name || app.process_name || "未知应用",
    process_name: app.process_name,
    monitor_enabled: shouldEnableMonitoringByDefault(app),
    user_confirmed: userConfirmed,
    discovery_source: app.source,
    discovered_at: nowLabel(),
  };

  return {
    id: appPermissionId(basePermission),
    ...basePermission,
  };
}

function mergeAppPermissions(
  currentPermissions: AppPermission[],
  detectedApps: DetectedApp[],
) {
  const merged: AppPermission[] = [];

  for (const currentPermission of currentPermissions) {
    mergePermissionIntoList(merged, currentPermission);
  }

  for (const detectedApp of detectedApps) {
    const permission = createAppPermission(detectedApp, true);
    mergePermissionIntoList(merged, permission);
  }

  return sortAppPermissions(merged);
}

function mergePermissionIntoList(
  permissions: AppPermission[],
  nextPermission: AppPermission,
) {
  const normalizedNextPermission = normalizeAppPermissionRecord(nextPermission);
  const existingIndex = permissions.findIndex((permission) =>
    areSameAppPermission(permission, normalizedNextPermission),
  );

  if (existingIndex === -1) {
    permissions.push(normalizedNextPermission);
    return;
  }

  const existingPermission = normalizeAppPermissionRecord(permissions[existingIndex]);
  const shouldAdoptNextDecision =
    !existingPermission.user_confirmed && normalizedNextPermission.user_confirmed;
  permissions[existingIndex] = normalizeAppPermissionRecord({
    ...existingPermission,
    id: normalizedNextPermission.process_name
      ? normalizedNextPermission.id
      : existingPermission.id,
    app_name: existingPermission.app_name || normalizedNextPermission.app_name,
    process_name:
      existingPermission.process_name || normalizedNextPermission.process_name,
    discovery_source: mergeDiscoverySource(
      existingPermission.discovery_source,
      normalizedNextPermission.discovery_source,
    ),
    monitor_enabled: shouldAdoptNextDecision
      ? normalizedNextPermission.monitor_enabled
      : existingPermission.monitor_enabled,
    user_confirmed: existingPermission.user_confirmed || normalizedNextPermission.user_confirmed,
  });
}

function areSameAppPermission(left: AppPermission, right: AppPermission) {
  if (left.id === right.id) {
    return true;
  }

  const leftAliases = appNameAliases(left);
  const rightAliases = appNameAliases(right);
  return [...leftAliases].some((alias) => rightAliases.has(alias));
}

function mergeDiscoverySource(left: string, right: string) {
  const sources = new Set([...left.split("+"), ...right.split("+")].filter(Boolean));
  return [...sources].join("+");
}

function permissionFromSnapshot(snapshot: ForegroundWindowSnapshot) {
  return createAppPermission(
    {
      app_name: snapshot.app_name,
      process_name: snapshot.process_name,
      source: "foreground_window_runtime",
    },
    false,
  );
}

function sortAppPermissions(permissions: AppPermission[]) {
  return [...permissions].sort((left, right) =>
    Number(right.monitor_enabled) - Number(left.monitor_enabled) ||
    Number(left.user_confirmed) - Number(right.user_confirmed) ||
    left.app_name.toLowerCase().localeCompare(right.app_name.toLowerCase()),
  );
}

function normalizeAppPermissions(permissions: AppPermission[]) {
  const merged: AppPermission[] = [];
  for (const permission of permissions) {
    mergePermissionIntoList(merged, permission);
  }

  return sortAppPermissions(merged);
}

function aiSettingsFingerprint(settings: Settings, apiKey: string) {
  return JSON.stringify({
    apiUrl: settings.apiUrl,
    apiKey,
    screenshotModel: settings.screenshotModel,
    navigationModel: settings.navigationModel,
  });
}

function appPermissionsFingerprint(appPermissions: AppPermission[]) {
  return JSON.stringify({
    appPermissions: normalizeAppPermissions(appPermissions),
  });
}

function shouldEnableMonitoringByDefault(app: DetectedApp) {
  if (isWeChatApp(app)) {
    return false;
  }

  return [
    "public_desktop",
    "user_desktop",
    "taskbar_pinned",
  ].includes(app.source);
}

function appNameAliases(app: Pick<AppPermission, "app_name" | "process_name">) {
  const appName = app.app_name.trim();
  const processName = app.process_name.trim();
  return new Set(
    [
      appName,
      processName,
      processName.replace(/\.exe$/i, ""),
      appName.replace(/\s*-\s*快捷方式$/i, ""),
      appName.replace(/\s+shortcut$/i, ""),
    ]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isWeChatApp(app: Pick<AppPermission, "app_name" | "process_name">) {
  const value = `${app.app_name} ${app.process_name}`.toLowerCase();
  return value.includes("wechat") || value.includes("weixin") || value.includes("微信");
}

function canSampleApp(snapshot: ForegroundWindowSnapshot, permissions: AppPermission[]) {
  const permission = findAppPermission(snapshot, permissions);
  return Boolean(permission?.monitor_enabled && permission.user_confirmed);
}

function findAppPermission(
  snapshot: ForegroundWindowSnapshot,
  permissions: AppPermission[],
) {
  const id = appPermissionId({
    app_name: snapshot.app_name,
    process_name: snapshot.process_name,
  });
  const snapshotAliases = appNameAliases({
    app_name: snapshot.app_name,
    process_name: snapshot.process_name,
  });

  return permissions.find((item) => {
    if (item.id === id) {
      return true;
    }

    const itemAliases = appNameAliases(item);
    return [...snapshotAliases].some((alias) => itemAliases.has(alias));
  });
}

const referencePlan: ReferencePlan = {
  scenario: "create_reference_task_plan",
  should_notify: false,
  body: "已为当前任务生成参考拆解：先搭建桌面壳，再记录基础事件，最后跑通任务分析到提示气泡的闭环。",
  reference_stages: [
    {
      stage_id: "stage_01",
      stage_title: "搭建桌面壳",
      stage_goal: "创建 Tauri 应用，能打开主面板并展示状态页。",
      minimum_estimated_minutes: 60,
    },
    {
      stage_id: "stage_02",
      stage_title: "记录基础事件",
      stage_goal: "记录前台应用、窗口标题、Enter 和 Ctrl+C 事件。",
      minimum_estimated_minutes: 80,
    },
    {
      stage_id: "stage_03",
      stage_title: "跑通提示闭环",
      stage_goal: "使用任务分析结果返回提示，并在右下角发光球气泡中展示。",
      minimum_estimated_minutes: 90,
    },
  ],
};

const notificationScenarios: Record<string, NotificationScenario> = {
  stuck: {
    scenario: "stuck_notification",
    should_notify: true,
    notify_type: "stuck",
    body: "你在通知区域图标和窗口监听问题上停留了一段时间。已经做过搜索示例、修改初始化代码、重启验证这些尝试。可以先用最小 tray 示例单独验证，或者暂时用主窗口按钮代替入口，把后面的提示闭环先跑起来。",
    button: "none",
  },
  offTrack: {
    scenario: "off_track_notification",
    should_notify: true,
    notify_type: "off_track",
    body: "当前主要在看桌面宠物动画资源。如果目标是今天 18:00 前跑通 SuperGuider 最小 Demo，可能先完成任务分析到提示气泡的闭环会更快。",
    button: "actually_related",
  },
  overOptimizing: {
    scenario: "over_optimizing_notification",
    should_notify: true,
    notify_type: "over_optimizing",
    body: "当前可能已经进入发光球视觉细节优化了。但任务分析到气泡展示和自动消失记录还没有完整跑通，建议先用朴素样式验证一次主闭环。",
    button: "important_detail",
  },
  noNotify: {
    scenario: "do_not_prompt_this_time",
    should_notify: false,
    notify_type: "none",
    body: "",
    button: "none",
  },
};

function nowLabel() {
  return dateTimeLabel(new Date());
}

function timeLabelFromTimestamp(timestamp: number) {
  return dateTimeLabel(new Date(timestamp));
}

function dateTimeLabel(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function datetimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfToday() {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date;
}

function activityLogTimeToTimestamp(time: string) {
  const fullMatch = time
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    );
  if (fullMatch) {
    return new Date(
      Number(fullMatch[1]),
      Number(fullMatch[2]) - 1,
      Number(fullMatch[3]),
      Number(fullMatch[4]),
      Number(fullMatch[5]),
      Number(fullMatch[6] ?? "0"),
      0,
    ).getTime();
  }

  return undefined;
}

function defaultDetailsTimeRange(mode: AppMode, task: Task | null) {
  if (mode === "task_tracking" && task) {
    const start = task.startedAt ? new Date(task.startedAt) : startOfToday();
    const deadline = new Date(task.deadline);
    const end =
      Number.isNaN(deadline.getTime()) || deadline.getTime() < start.getTime()
        ? new Date()
        : deadline;
    return {
      start: datetimeLocalValue(start),
      end: datetimeLocalValue(end),
    };
  }

  return {
    start: datetimeLocalValue(startOfToday()),
    end: datetimeLocalValue(endOfToday()),
  };
}

function chatCompletionsEndpointLabel(apiUrl: string) {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function sampleSummaryLabel(sample: ContextSampleRecord) {
  const windowLabel = sample.window
    ? `${sample.window.app_name} / ${sample.window.window_title}`
    : "无窗口";
  const screenshotLabelText = sample.screenshot?.file_name ?? "未截图";
  return `${windowLabel} · ${screenshotLabelText}`;
}

function queueKindLabel(kind: AnalysisWorkKind) {
  return kind === "screenshot" ? "截图分析" : "任务分析";
}

function missingScreenshotFileMessage(sample: ContextSampleRecord) {
  if (sample.screenshot?.file_path) {
    return "";
  }

  return "本地样本没有可用于分析的截图文件，已从截图分析队列移除。";
}

function createRecordId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function retryDelayMs(attemptsAfterFailure: number) {
  const delays = [
    0,
    1 * 60 * 1000,
    2 * 60 * 1000,
    3 * 60 * 1000,
    5 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
  ];

  return delays[Math.min(attemptsAfterFailure - 1, delays.length - 1)] ?? 0;
}

function emptyQueueRetryState(): QueueRetryState {
  return {
    screenshot: {
      failureCount: 0,
      pausedUntil: null,
    },
    task: {
      failureCount: 0,
      pausedUntil: null,
    },
  };
}

function pendingAnalysisResult(sample: ContextSampleRecord): AnalysisResult {
  return validateAnalysisResult({
    recordedAt: nowLabel(),
    scenario: "screenshot_waiting_for_analysis",
    should_notify: false,
    notify_type: "none",
    body: "截图未分析",
    basis: sample.screenshot?.file_name
      ? `截图文件：${sample.screenshot.file_name}`
      : "截图已进入待分析流程。",
    button: "none",
  });
}

function snapshotKey(snapshot: ForegroundWindowSnapshot) {
  return [
    snapshot.app_name.trim().toLowerCase(),
    snapshot.process_name.trim().toLowerCase(),
    readableWindowTitle(snapshot),
  ].join("|");
}

function readableWindowTitle(snapshot: ForegroundWindowSnapshot) {
  const processName = snapshot.process_name.trim().toLowerCase();
  const folderPath = snapshot.folder_path?.trim();
  const title = snapshot.window_title.trim();

  if (processName === "explorer" || processName === "explorer.exe") {
    if (folderPath) {
      return folderPath;
    }

    if (
      !title ||
      title === "无具体窗口" ||
      title === "Untitled window" ||
      isExplorerSystemWindowTitle(title)
    ) {
      return "";
    }
  }

  return title && title !== "Untitled window" ? title : "无具体窗口";
}

function screenshotLabel(screenshot: ScreenshotCaptureResult | null) {
  if (!screenshot) {
    return "未截图";
  }

  return screenshot.file_name || screenshot.file_path || screenshot.status;
}

function activitySwitchLine(recordedAt: string, snapshot: ForegroundWindowSnapshot) {
  return `${recordedAt}，${snapshot.app_name}，${readableWindowTitle(snapshot)}`;
}

function activitySampleLine(
  recordedAt: string,
  snapshot: ForegroundWindowSnapshot | null,
  screenshot: ScreenshotCaptureResult | null,
  analysis: AnalysisResult,
  fallbackStatus?: string,
) {
  const appName = snapshot?.app_name ?? "Unknown App";
  const windowTitle = snapshot ? readableWindowTitle(snapshot) : "";
  if (isAppPermissionBlockStatus(fallbackStatus)) {
    return `${recordedAt}，${appName}，${windowTitle}，已跳过截图，`;
  }

  const screenshotText = screenshot
    ? `截图 ${screenshotLabel(screenshot)}`
    : `未截图${fallbackStatus ? `（${fallbackStatus}）` : ""}`;
  const analysisText = analysis.body || analysis.scenario || "待分析";
  return `${recordedAt}，${appName}，${windowTitle}，${screenshotText}，内容 ${analysisText}`;
}

function parseActivityLogTable(content: string): ActivityLogTableRow[] {
  const rows: ActivityLogTableRow[] = [];
  let lastRawApp = "";
  let lastShownWindow = "";
  let lastTimestampMs: number | undefined;

  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("格式：")) {
      return;
    }

    if (trimmed.startsWith("，")) {
      const sample = parseActivitySampleLine(trimmed);
      if (!sample.screenshot) {
        rows.push({
          id: `sample-${index}`,
          time: "",
          app: "",
          displayApp: "",
          rawApp: "",
          rawWindowTitle: "",
          windowTitle: "",
          screenshot: "",
          content: sample.content,
          appBreak: false,
          muted: sample.muted,
          timestampMs: lastTimestampMs,
        });
        return;
      }

      const inferred = inferActivityTargetFromScreenshotName(sample.screenshot);
      if (isExplorerLogShellSurface(inferred.app, inferred.windowTitle)) {
        return;
      }

      const time = inferActivityTimeFromScreenshotName(sample.screenshot);
      const timestampMs = time ? activityLogTimeToTimestamp(time) : lastTimestampMs;
      const display = displayActivityTarget(inferred.app, inferred.windowTitle);
      const rawAppKey = display.app.toLowerCase();
      const appBreak = Boolean(display.app) && rawAppKey !== lastRawApp;
      const app = rawAppKey === lastRawApp ? "" : display.app;
      const windowTitle =
        rawAppKey === lastRawApp && display.windowTitle === lastShownWindow
          ? ""
          : display.windowTitle;

      rows.push({
        id: `sample-${index}`,
        time,
        app,
        displayApp: display.app,
        rawApp: inferred.app,
        rawWindowTitle: inferred.windowTitle,
        windowTitle,
        screenshot: sample.screenshot,
        content: sample.content,
        appBreak,
        muted: sample.muted,
        timestampMs,
      });
      if (display.app) {
        lastRawApp = rawAppKey;
        lastShownWindow = display.windowTitle;
      }
      return;
    }

    const [
      time = "",
      rawApp = "",
      rawWindow = "",
      rawScreenshot = "",
      ...rawContentParts
    ] = splitActivitySwitchLine(trimmed);
    const rawContent = rawContentParts.join("，");
    const timestampMs = activityLogTimeToTimestamp(time);
    if (isExplorerLogShellSurface(rawApp, rawWindow)) {
      lastTimestampMs = timestampMs ?? lastTimestampMs;
      return;
    }

    const display = displayActivityTarget(rawApp, rawWindow);
    const rawAppKey = display.app.toLowerCase();
    const appBreak = rows.length > 0 && rawAppKey !== lastRawApp;
    const app = rawAppKey === lastRawApp ? "" : display.app;
    const windowTitle =
      rawAppKey === lastRawApp && display.windowTitle === lastShownWindow
        ? ""
        : display.windowTitle;
    const screenshot = parseActivityScreenshotText(rawScreenshot);
    const content = mergeActivityContent(
      display.content,
      parseActivityContentText(rawContent),
    );
    if (!app && !windowTitle && !content && !screenshot) {
      return;
    }

    rows.push({
      id: `switch-${index}`,
      time,
      app,
      displayApp: display.app,
      rawApp,
      rawWindowTitle: rawWindow,
      windowTitle,
      screenshot,
      content,
      appBreak,
      muted: isAppPermissionBlockText(`${rawScreenshot} ${rawContent}`),
      timestampMs,
    });

    lastRawApp = rawAppKey;
    lastShownWindow = display.windowTitle;
    lastTimestampMs = timestampMs;
  });

  return rows;
}

function splitActivitySwitchLine(line: string) {
  return line.split("，");
}

function parseActivitySampleLine(line: string) {
  const content = line.replace(/^，/, "");
  const separator = content.indexOf("，");
  const screenshot = separator === -1 ? content : content.slice(0, separator);
  const contentText = separator === -1 ? "" : content.slice(separator + 1);

  if (isAppPermissionBlockText(`${screenshot} ${contentText}`)) {
    return {
      screenshot: "",
      content: "",
      muted: true,
    };
  }

  return {
    screenshot: parseActivityScreenshotText(screenshot),
    content: parseActivityContentText(contentText),
    muted: false,
  };
}

function parseActivityScreenshotText(text: string) {
  return text.replace(/^截图\s*/, "") || "";
}

function parseActivityContentText(text: string) {
  return text.replace(/^(分析|内容)\s*/, "") || "";
}

function inferActivityTimeFromScreenshotName(screenshot: string) {
  const match = screenshot.match(/(\d{8})-(\d{6})-\d{3}/);
  if (!match) {
    return "";
  }

  const [, date, time] = match;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(
    0,
    2,
  )}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

function inferActivityTargetFromScreenshotName(screenshot: string) {
  const fileName = screenshot.split(/[\\/]/).pop() ?? screenshot;
  const stem = fileName.replace(/\.[^.]+$/, "");
  const modernMatch = stem.match(/^\d{8}-\d{6}-\d{3}_(.+)$/);
  const body = modernMatch?.[1] ?? stem;
  const [app = "", ...windowParts] = body.split("_");

  return {
    app: app || "Unknown App",
    windowTitle: windowParts.join("_").replace(/_/g, " ") || "",
  };
}

function mergeActivityContent(current: string, next: string) {
  const currentContent = current.trim();
  const nextContent = next.trim();
  if (!currentContent) {
    return nextContent;
  }
  if (!nextContent) {
    return currentContent;
  }
  return `${currentContent}\n${nextContent}`;
}

function isAppPermissionBlockStatus(status?: string) {
  return isAppPermissionBlockText(status ?? "");
}

function isAppPermissionBlockText(text: string) {
  return [
    "已在设置中关闭监控",
    "尚未在设置中确认允许监控",
    "是新发现应用",
    "已跳过截图",
  ].some((keyword) => text.includes(keyword));
}

function displayActivityTarget(rawApp: string, rawWindow: string) {
  const app = rawApp.trim();
  const windowTitle = normalizeWindowTitle(rawWindow);
  const appKey = app.toLowerCase();

  if (appKey === "explorer" || appKey === "explorer.exe") {
    if (isExplorerShellSurface(windowTitle)) {
      return { app: "桌面", windowTitle: "", content: "" };
    }

    return { app: "文件夹", windowTitle: compactActivityTitle(windowTitle), content: "" };
  }

  if (isTerminalApp(appKey)) {
    return { app: "终端", windowTitle: "", content: compactActivityTitle(windowTitle, 88) };
  }

  if (isBrowserApp(appKey)) {
    return {
      app: browserDisplayName(appKey),
      windowTitle: compactActivityTitle(normalizeBrowserWindowTitle(windowTitle, appKey), 120),
      content: "",
    };
  }

  const displayApp =
    appKey === "notepad" || appKey === "notepad.exe" ? "记事本" : app;
  const normalizedApp = displayApp.trim().toLowerCase();
  const normalizedWindow = windowTitle.trim().toLowerCase();

  return {
    app: displayApp,
    windowTitle:
      normalizedApp && normalizedApp === normalizedWindow
        ? ""
        : compactActivityTitle(windowTitle),
    content: "",
  };
}

function normalizeWindowTitle(value: string) {
  const title = value.trim();
  return title === "无具体窗口" || title === "Untitled window" ? "" : title;
}

function isExplorerSystemWindowTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return [
    "任务切换",
    "task switching",
    "program manager",
  ].includes(normalized);
}

function isExplorerShellSurface(title: string) {
  return !title || isExplorerSystemWindowTitle(title);
}

function isExplorerLogShellSurface(rawApp: string, rawWindow: string) {
  const appKey = rawApp.trim().toLowerCase();
  return (
    (appKey === "explorer" || appKey === "explorer.exe") &&
    isExplorerShellSurface(normalizeWindowTitle(rawWindow))
  );
}

function isShellOnlyForegroundSnapshot(snapshot: ForegroundWindowSnapshot) {
  const processName = snapshot.process_name.trim().toLowerCase();
  const appName = snapshot.app_name.trim().toLowerCase();
  if (
    processName !== "explorer.exe" &&
    processName !== "explorer" &&
    appName !== "explorer.exe" &&
    appName !== "explorer"
  ) {
    return false;
  }

  return !snapshot.folder_path?.trim() && isExplorerShellSurface(snapshot.window_title);
}

function isTerminalApp(appKey: string) {
  return [
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "windowsterminal",
    "windowsterminal.exe",
    "wt",
    "wt.exe",
  ].includes(appKey);
}

function isBrowserApp(appKey: string) {
  return [
    "chrome",
    "chrome.exe",
    "firefox",
    "firefox.exe",
    "msedge",
    "msedge.exe",
    "edge",
    "edge.exe",
    "brave",
    "brave.exe",
  ].includes(appKey);
}

function browserDisplayName(appKey: string) {
  if (appKey === "firefox" || appKey === "firefox.exe") {
    return "Firefox";
  }

  if (
    appKey === "msedge" ||
    appKey === "msedge.exe" ||
    appKey === "edge" ||
    appKey === "edge.exe"
  ) {
    return "Edge";
  }

  if (appKey === "brave" || appKey === "brave.exe") {
    return "Brave";
  }

  return "Chrome";
}

function normalizeBrowserWindowTitle(title: string, appKey: string) {
  const suffixes =
    appKey === "firefox" || appKey === "firefox.exe"
      ? [" - Mozilla Firefox", " — Mozilla Firefox"]
      : appKey === "msedge" ||
          appKey === "msedge.exe" ||
          appKey === "edge" ||
          appKey === "edge.exe"
        ? [" - Microsoft Edge", " — Microsoft Edge"]
        : appKey === "brave" || appKey === "brave.exe"
          ? [" - Brave", " — Brave"]
          : [" - Google Chrome", " — Google Chrome"];

  let normalized = title.trim();
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim();
      break;
    }
  }

  return normalized;
}

function compactActivityTitle(value: string, maxLength = 120) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}...`;
}

function analyzeContextSample(sample: ContextSampleRecord): AnalysisResult {
  if (sample.error) {
    return validateAnalysisResult({
      recordedAt: nowLabel(),
      scenario: "context_sample_failed",
      should_notify: false,
      notify_type: "none",
      body: "这次上下文采样失败，先不打扰用户。",
      basis: sample.error,
      button: "none",
    });
  }

  const appName = sample.window?.app_name ?? "未知应用";
  const windowTitle = sample.window?.window_title ?? "未知窗口";
  const screenshotStatus = sample.screenshot?.status ?? "unknown";
  const screenshotBasis = sample.screenshotAnalysis
    ? `；截图摘要：${sample.screenshotAnalysis}${
        sample.screenshotDetailText
          ? `；截图详细转文字：${sample.screenshotDetailText}`
          : ""
      }`
    : "";
  const surfaceText = `${appName} ${windowTitle}`.toLowerCase();
  const distractionKeywords = [
    "bilibili",
    "youtube",
    "douyin",
    "抖音",
    "游戏",
    "视频",
    "直播",
    "steam",
  ];
  const looksDistracting = distractionKeywords.some((keyword) =>
    surfaceText.includes(keyword),
  );

  if (sample.taskGoal !== "未开始任务" && looksDistracting) {
    return validateAnalysisResult({
      recordedAt: nowLabel(),
      scenario: "local_off_track_detected",
      should_notify: true,
      notify_type: "off_track",
      body: `当前窗口看起来可能和任务目标关系不大：${appName} / ${windowTitle}。如果你正在执行「${sample.taskGoal}」，可以先回到任务主线。`,
      basis: `${appName} / ${windowTitle} / 截图状态：${screenshotStatus}${screenshotBasis}`,
      button: "actually_related",
    });
  }

  return validateAnalysisResult({
    recordedAt: nowLabel(),
    scenario: "context_sample_checked",
    should_notify: false,
    notify_type: "none",
    body: "已完成一次上下文采样。本地分析层暂不主动提示，只记录判断依据。",
    basis: `${appName} / ${windowTitle} / 截图状态：${screenshotStatus}${screenshotBasis}`,
    button: "none",
  });
}

function notificationFromAnalysis(
  result: AnalysisResult,
): NotificationScenario {
  return {
    scenario: result.scenario,
    should_notify: result.should_notify,
    notify_type: result.notify_type,
    body: result.body,
    button: result.button,
  };
}

function loadStoredState(): StoredAppState {
  if (typeof window === "undefined") {
    return defaultStoredState;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return defaultStoredState;
    }

    const parsed = JSON.parse(raw) as Partial<StoredAppState>;
    return normalizeStoredState(parsed);
  } catch {
    return defaultStoredState;
  }
}

function normalizeStoredState(state: Partial<StoredAppState>): StoredAppState {
  // 旧版本本地状态可能缺字段；这里统一补默认值，避免升级后读取 SQLite/localStorage 崩掉。
  return {
    task: state.task ?? null,
    notificationRecords: state.notificationRecords ?? [],
    inputEventRecords: state.inputEventRecords ?? [],
    activityLogRecords: state.activityLogRecords ?? [],
    requestQueues: state.requestQueues ?? defaultStoredState.requestQueues,
    contextSamples: state.contextSamples ?? [],
    analysisResults: state.analysisResults ?? [],
    summary: state.summary ?? null,
  };
}

function App() {
  // React 初始渲染只能先用默认值；真正的私密配置会在下面的 loadStoredData 里从本机文件恢复。
  const storedState = loadStoredState();
  const initialDetailsTimeRange = defaultDetailsTimeRange(
    storedState.task ? "task_tracking" : "silent_companion",
    storedState.task,
  );
  const [page, setPage] = useState<Page>("status");
  const [mode, setMode] = useState<AppMode>(
    storedState.task ? "task_tracking" : "silent_companion",
  );
  const [task, setTask] = useState<Task | null>(storedState.task);
  const [draftTask, setDraftTask] = useState<Task>({
    goal: "",
    deadline: "",
    notes: "",
  });
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [apiKey, setApiKey] = useState("");
  const [aiSettingsSaveStatus, setAiSettingsSaveStatus] =
    useState<AiSettingsSaveStatus>("idle");
  const [appPermissionsSaveStatus, setAppPermissionsSaveStatus] =
    useState<AppPermissionsSaveStatus>("idle");
  const [activeNotification, setActiveNotification] =
    useState<NotificationScenario | null>(null);
  const [notificationRecords, setNotificationRecords] = useState<
    NotificationRecord[]
  >(storedState.notificationRecords);
  const [inputEventRecords, setInputEventRecords] = useState<InputEventRecord[]>(
    storedState.inputEventRecords,
  );
  const [activityLogRecords, setActivityLogRecords] = useState<ActivityLogRecord[]>(
    storedState.activityLogRecords,
  );
  const [requestQueues, setRequestQueues] = useState<RequestQueues>(
    storedState.requestQueues,
  );
  const [contextSamples, setContextSamples] = useState<ContextSampleRecord[]>(
    storedState.contextSamples,
  );
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>(
    storedState.analysisResults,
  );
  const [summary, setSummary] = useState<TaskSummary | null>(
    storedState.summary,
  );
  const [windowSnapshot, setWindowSnapshot] =
    useState<ForegroundWindowSnapshot | null>(null);
  const [windowSnapshotError, setWindowSnapshotError] = useState("");
  const [screenshotResult, setScreenshotResult] =
    useState<ScreenshotCaptureResult | null>(null);
  const [screenshotError, setScreenshotError] = useState("");
  const [activityLogPath, setActivityLogPath] = useState("");
  const [activityLogContent, setActivityLogContent] = useState("");
  const [activityLogError, setActivityLogError] = useState("");
  const [apiRequestLogPath, setApiRequestLogPath] = useState("");
  const [apiRequestLogContent, setApiRequestLogContent] = useState("");
  const [apiRequestLogError, setApiRequestLogError] = useState("");
  const [activeScreenshotAnalysis, setActiveScreenshotAnalysis] =
    useState<ActiveAnalysisWork | null>(null);
  const [activeTaskAnalysis, setActiveTaskAnalysis] =
    useState<ActiveAnalysisWork | null>(null);
  const [queuePaused, setQueuePaused] = useState<QueuePauseState>({
    screenshot: false,
    task: false,
  });
  const [queueRetryState, setQueueRetryState] = useState<QueueRetryState>(
    emptyQueueRetryState,
  );
  const [detailsTimeRange, setDetailsTimeRange] = useState(
    initialDetailsTimeRange,
  );
  const [detailsTimeRangeTouched, setDetailsTimeRangeTouched] = useState(false);
  const [hoveringNotification, setHoveringNotification] = useState(false);
  const [databaseLoaded, setDatabaseLoaded] = useState(false);
  const lastForegroundWindowKey = useRef<string | null>(null);
  const foregroundScreenshotTimerRef = useRef<number | null>(null);
  const lastScreenshotAttemptAtRef = useRef(0);
  const altTabSuppressionRef = useRef({
    active: false,
    suppressUntilMs: 0,
    startedAtMs: 0,
    lastPulseAtMs: 0,
  });
  const altTabEndTimerRef = useRef<number | null>(null);
  const altTabWatchdogTimerRef = useRef<number | null>(null);
  const captureContextSampleRef = useRef<
    (trigger?: ContextSampleTrigger) => Promise<void>
  >(async () => undefined);
  const screenshotQueueProcessingRef = useRef(false);
  const taskQueueProcessingRef = useRef(false);
  const latestSettingsRef = useRef(settings);
  const latestApiKeyRef = useRef(apiKey);
  const aiSettingsSaveChainRef = useRef(Promise.resolve());
  const appPermissionsSaveChainRef = useRef(Promise.resolve());

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    latestApiKeyRef.current = apiKey;
  }, [apiKey]);

  const initialized =
    settings.apiUrl &&
    apiKey &&
    settings.screenshotModel &&
    settings.navigationModel;

  useEffect(() => {
    let cancelled = false;

    async function loadStoredData() {
      try {
        // 三类启动数据并行读取：普通运行状态、私密设置、系统可发现应用。
        // 私密设置来自 %LOCALAPPDATA%\SuperGuider\private-settings.json，不进入 Git。
        const [rawState, privateSettings, detectedApps] = await Promise.all([
          invoke<string | null>("load_app_state"),
          invoke<PrivateSettings | null>("load_private_settings"),
          invoke<DetectedApp[]>("scan_installed_apps"),
        ]);
        if (cancelled) {
          return;
        }

        if (rawState) {
          applyStoredState(normalizeStoredState(JSON.parse(rawState)));
        }

        if (privateSettings) {
          // 应用权限以 private-settings.json 为主，再合并本次扫描到的新应用。
          // 合并只补新应用，不覆盖用户已经确认过的“加入/拒绝”决定。
          const appPermissions = mergeAppPermissions(
            privateSettings.app_permissions ?? [],
            detectedApps,
          );
          const nextSettings = {
            apiUrl: privateSettings.api_url,
            screenshotModel: privateSettings.screenshot_model,
            navigationModel: privateSettings.navigation_model,
            appPermissions,
          };
          latestSettingsRef.current = nextSettings;
          latestApiKeyRef.current = privateSettings.api_key;
          setSettings(nextSettings);
          setApiKey(privateSettings.api_key);
          if (
            JSON.stringify(privateSettings.app_permissions ?? []) !==
            JSON.stringify(appPermissions)
          ) {
            // 如果扫描补充了新应用，只局部保存 app_permissions，绝不碰 API Key/URL/模型字段。
            void saveAppPermissions(appPermissions).catch((error) => {
              console.warn("Could not normalize private settings", error);
            });
          }
        } else {
          const nextSettings = {
            ...defaultSettings,
            appPermissions: mergeAppPermissions([], detectedApps),
          };
          latestSettingsRef.current = nextSettings;
          setSettings(nextSettings);
        }
      } catch (error) {
        console.warn("Could not load stored data", error);
      } finally {
        if (!cancelled) {
          setDatabaseLoaded(true);
        }
      }
    }

    void loadStoredData();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    invoke<string>("get_activity_log_path")
      .then(setActivityLogPath)
      .catch((error) => {
        console.warn("Could not read activity log path", error);
      });

    invoke<string>("get_api_request_log_path")
      .then(setApiRequestLogPath)
      .catch((error) => {
        console.warn("Could not read API request log path", error);
      });
  }, []);

  useEffect(() => {
    if (page === "details") {
      if (!detailsTimeRangeTouched) {
        setDetailsTimeRange(defaultDetailsTimeRange(mode, task));
      }
      void refreshActivityLog();
      void refreshApiRequestLog();
    }
  }, [page, detailsTimeRangeTouched, mode, task]);

  useEffect(() => {
    if (detailsTimeRangeTouched) {
      return;
    }

    setDetailsTimeRange(defaultDetailsTimeRange(mode, task));
  }, [detailsTimeRangeTouched, mode, task]);

  useEffect(() => {
    // 运行状态持久化到 localStorage + SQLite，方便重启后恢复任务、队列、采样记录。
    // API Key 等私密字段不在这里保存，避免混入普通状态。
    const stateToStore: StoredAppState = {
      task,
      notificationRecords,
      inputEventRecords,
      activityLogRecords,
      requestQueues,
      contextSamples,
      analysisResults,
      summary,
    };
    const stateJson = JSON.stringify(stateToStore);
    window.localStorage.setItem(storageKey, stateJson);

    if (databaseLoaded) {
      void invoke("save_app_state", { state: { state_json: stateJson } }).catch(
        (error) => {
          console.warn("Could not save SQLite app state", error);
        },
      );
    }
  }, [
    databaseLoaded,
    task,
    notificationRecords,
    inputEventRecords,
    activityLogRecords,
    requestQueues,
    contextSamples,
    analysisResults,
    summary,
  ]);

  useEffect(() => {
    if (!databaseLoaded) {
      return;
    }

    // 应用监控范围变化后自动保存，但只调用 saveAppPermissions。
    // 这是为了避免用户改“加入/拒绝”时把 API 配置误写成空。
    void saveAppPermissions(settings.appPermissions);
  }, [databaseLoaded, settings.appPermissions]);

  useEffect(() => {
    return () => {
      clearForegroundScreenshotTimer();
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    async function pollForegroundWindow() {
      try {
        // 兜底轮询前台窗口。即便 Rust 事件偶尔漏发，前端也能每秒确认一次当前窗口。
        const snapshot = await invoke<ForegroundWindowSnapshot>(
          "get_foreground_window_snapshot",
        );
        if (disposed) {
          return;
        }

        handleForegroundSnapshot(snapshot);
      } catch (error) {
        if (!disposed) {
          console.warn("Could not poll foreground window", error);
        }
      }
    }

    void pollForegroundWindow();
    const interval = window.setInterval(() => {
      void pollForegroundWindow();
    }, 1000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [apiKey, settings.apiUrl, settings.navigationModel, settings.screenshotModel]);

  useEffect(() => {
    let disposed = false;
    let unlistenForegroundWindow: (() => void) | null = null;

    // Rust 后台线程会推送前台窗口变化事件；前端收到后负责去重、记录、安排稳定截图。
    listen<ForegroundWindowSnapshot>("superguider://foreground-window", (event) => {
      if (!disposed) {
        handleForegroundSnapshot(event.payload);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unlistenForegroundWindow = unlisten;
    });

    return () => {
      disposed = true;
      unlistenForegroundWindow?.();
    };
  }, [apiKey, settings.apiUrl, settings.navigationModel, settings.screenshotModel]);

  useEffect(() => {
    let disposed = false;
    let unlistenGlobalInput: (() => void) | null = null;

    // 全局 Enter/Ctrl+C 来自 Windows 低级键盘 hook。
    // Enter 和 Ctrl+C 都走同一条采样路径，这样日志、权限检查、截图队列完全一致。
    listen<GlobalInputEvent>("superguider://global-input", (event) => {
      if (disposed) {
        return;
      }

      if (event.payload.event_type === "alt_tab_pulse") {
        handleAltTabPulse();
        return;
      }

      if (event.payload.event_type === "alt_tab_end") {
        finishAltTabSuppression();
        return;
      }

      recordInputEvent(event.payload.event_type, event.payload.source);
      if (
        event.payload.event_type === "screenshot" ||
        event.payload.event_type === "enter"
      ) {
        void captureContextSample(event.payload.source);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unlistenGlobalInput = unlisten;
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Enter") {
        recordInputEvent("enter", "frontend_window");
        void captureContextSample("frontend_window");
      }

      if (event.ctrlKey && event.key.toLowerCase() === "c") {
        recordInputEvent("screenshot", "frontend_window");
        void captureContextSample("frontend_window");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      disposed = true;
      unlistenGlobalInput?.();
      window.removeEventListener("keydown", handleKeyDown);
      clearAltTabTimer(altTabEndTimerRef);
      clearAltTabTimer(altTabWatchdogTimerRef);
    };
  }, [apiKey, settings, task]);

  useEffect(() => {
    if (!databaseLoaded) {
      return;
    }

    // 最大三分钟兜底采样：如果用户长时间停留在同一应用，没有按键也没有切换，
    // 仍然会尝试做一次上下文采样，避免任务状态长时间没有新证据。
    if (!lastScreenshotAttemptAtRef.current) {
      lastScreenshotAttemptAtRef.current = Date.now();
    }

    const interval = window.setInterval(() => {
      const elapsed = Date.now() - lastScreenshotAttemptAtRef.current;
      if (
        !lastScreenshotAttemptAtRef.current ||
        elapsed >= maximumScreenshotIntervalMs
      ) {
        void captureContextSampleRef.current("interval_fallback");
      }
    }, screenshotIntervalCheckMs);

    return () => window.clearInterval(interval);
  }, [databaseLoaded]);

  useEffect(() => {
    if (!activeNotification || hoveringNotification) {
      return;
    }

    const timeout = window.setTimeout(() => {
      recordNotification(activeNotification, "auto_dismissed");
      setActiveNotification(null);
    }, 10000);

    return () => window.clearTimeout(timeout);
  }, [activeNotification, hoveringNotification]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void processDueScreenshotAnalysisQueue();
      void processDueTaskAnalysisQueue();
    }, 1000);

    void processDueScreenshotAnalysisQueue();
    void processDueTaskAnalysisQueue();

    return () => window.clearInterval(interval);
  }, [
    requestQueues,
    contextSamples,
    settings,
    apiKey,
    queuePaused,
    queueRetryState,
  ]);

  function createTask() {
    if (!draftTask.goal.trim()) {
      return;
    }

    if (!draftTask.deadline) {
      return;
    }

    const deadlineTime = new Date(draftTask.deadline).getTime();
    if (Number.isNaN(deadlineTime) || deadlineTime < Date.now()) {
      return;
    }

    const nextTask = {
      ...draftTask,
      startedAt: new Date().toISOString(),
    };
    setTask(nextTask);
    setMode("task_tracking");
    setSummary(null);
    if (!detailsTimeRangeTouched) {
      setDetailsTimeRange(defaultDetailsTimeRange("task_tracking", nextTask));
    }
    setDraftTask({ goal: "", deadline: "", notes: "" });
  }

  function triggerScenario(scenario: NotificationScenario) {
    if (!scenario.should_notify) {
      setActiveNotification(null);
      recordNotification(scenario, "not_shown");
      return;
    }

    setActiveNotification(scenario);
    recordNotification(scenario, "shown");
  }

  function updateDetailsTimeRange(updates: Partial<typeof detailsTimeRange>) {
    setDetailsTimeRange((current) => ({
      ...current,
      ...updates,
    }));
    setDetailsTimeRangeTouched(true);
  }

  function setDetailsRangeToday() {
    setDetailsTimeRange(defaultDetailsTimeRange("silent_companion", null));
    setDetailsTimeRangeTouched(true);
    void refreshActivityLog();
  }

  function clearAltTabTimer(timerRef: React.MutableRefObject<number | null>) {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function handleAltTabPulse() {
    const now = Date.now();
    const current = altTabSuppressionRef.current;
    altTabSuppressionRef.current = {
      active: true,
      suppressUntilMs: now + altTabWatchdogMs,
      startedAtMs: current.active ? current.startedAtMs : now,
      lastPulseAtMs: now,
    };

    clearAltTabTimer(altTabEndTimerRef);
    clearAltTabTimer(altTabWatchdogTimerRef);
    altTabWatchdogTimerRef.current = window.setTimeout(() => {
      finishAltTabSuppression(altTabPostEndSuppressMs);
    }, altTabWatchdogMs);
  }

  function finishAltTabSuppression(extraSuppressMs = altTabPostEndSuppressMs) {
    const now = Date.now();
    altTabSuppressionRef.current = {
      ...altTabSuppressionRef.current,
      active: false,
      suppressUntilMs: now + extraSuppressMs,
    };

    clearAltTabTimer(altTabWatchdogTimerRef);
    clearAltTabTimer(altTabEndTimerRef);
    altTabEndTimerRef.current = window.setTimeout(() => {
      if (!altTabSuppressionRef.current.active) {
        altTabSuppressionRef.current = {
          active: false,
          suppressUntilMs: 0,
          startedAtMs: 0,
          lastPulseAtMs: 0,
        };
      }
    }, extraSuppressMs);
  }

  function isAltTabSuppressingForeground() {
    const current = altTabSuppressionRef.current;
    return current.active || current.suppressUntilMs > Date.now();
  }

  function handleForegroundSnapshot(snapshot: ForegroundWindowSnapshot) {
    // 先做稳定目标去重：同一个前台目标连续上报时，不重复写切换日志，也不重复安排截图。
    if (isAltTabSuppressingForeground()) {
      setWindowSnapshot(snapshot);
      clearForegroundScreenshotTimer();
      return;
    }

    if (isShellOnlyForegroundSnapshot(snapshot)) {
      setWindowSnapshot(snapshot);
      clearForegroundScreenshotTimer();
      return;
    }

    const nextKey = snapshotKey(snapshot);
    if (lastForegroundWindowKey.current === nextKey) {
      return;
    }

    lastForegroundWindowKey.current = nextKey;
    setWindowSnapshot(snapshot);
    ensureRuntimeAppPermission(snapshot);
    recordForegroundSwitch(snapshot);
    scheduleForegroundStableScreenshot(nextKey);
  }

  function clearForegroundScreenshotTimer() {
    if (foregroundScreenshotTimerRef.current) {
      window.clearTimeout(foregroundScreenshotTimerRef.current);
      foregroundScreenshotTimerRef.current = null;
    }
  }

  function scheduleForegroundStableScreenshot(nextKey: string) {
    clearForegroundScreenshotTimer();

    foregroundScreenshotTimerRef.current = window.setTimeout(() => {
      foregroundScreenshotTimerRef.current = null;
      if (lastForegroundWindowKey.current !== nextKey) {
        return;
      }

      void captureContextSampleRef.current("foreground_switch");
    }, foregroundStableScreenshotDelayMs);
  }

  function recordActivity(record: ActivityLogRecord, line: string) {
    // UI 内存态和磁盘活动日志同步写入；页面上的列表和 activity-log.md 保持同一份事实。
    setActivityLogRecords((records) => [record, ...records].slice(0, 500));
    void invoke("append_activity_log_line", { entry: { line } }).catch((error) => {
      console.warn("Could not append activity log", error);
    });
  }

  function recordForegroundSwitch(snapshot: ForegroundWindowSnapshot) {
    // 只记录“前台切换事实”，不在这里触发截图请求。
    // 截图由稳定 3 秒、键盘事件或最长间隔兜底统一触发。
    const recordedAt = nowLabel();
    recordActivity(
      {
        eventType: "switch",
        recordedAt,
        appName: snapshot.app_name,
        processName: snapshot.process_name,
        windowTitle: readableWindowTitle(snapshot),
      },
      activitySwitchLine(recordedAt, snapshot),
    );
  }

  function recordSampleActivity(
    sample: ContextSampleRecord,
    analysis: AnalysisResult,
    fallbackStatus?: string,
  ) {
    recordActivity(
      {
        eventType: sample.screenshot ? "screenshot" : "analysis",
        sampleId: sample.id,
        recordedAt: sample.recordedAt,
        appName: sample.window?.app_name,
        processName: sample.window?.process_name,
        windowTitle: sample.window ? readableWindowTitle(sample.window) : undefined,
        screenshotPath: sample.screenshot?.file_path ?? undefined,
        screenshotFileName: sample.screenshot?.file_name ?? undefined,
        status: sample.screenshot?.status ?? fallbackStatus,
        screenshotAnalysis: sample.screenshotAnalysis,
        analysisBody: analysis.body,
      },
      activitySampleLine(
        sample.recordedAt,
        sample.window,
        sample.screenshot,
        analysis,
        fallbackStatus,
      ),
    );
  }

  function ensureRuntimeAppPermission(snapshot: ForegroundWindowSnapshot) {
    const runtimePermission = permissionFromSnapshot(snapshot);
    setSettings((currentSettings) => {
      const existingPermission = findAppPermission(
        snapshot,
        currentSettings.appPermissions,
      );

      if (existingPermission) {
        return currentSettings;
      }

      const nextPermissions = [...currentSettings.appPermissions];
      mergePermissionIntoList(nextPermissions, runtimePermission);
      const nextSettings = {
        ...currentSettings,
        appPermissions: normalizeAppPermissions(nextPermissions),
      };

      latestSettingsRef.current = nextSettings;
      setAppPermissionsSaveStatus("idle");
      return nextSettings;
    });
  }

  function scheduleScreenshotAnalysis(sampleId: string) {
    // 截图已经落盘以后，先放入“截图分析”队列，延迟 5 秒再请求。
    // 这样连续切换窗口时，短时间内不会把网络请求打得太碎。
    const dueAt = Date.now() + 5000;
    setRequestQueues((queues) => ({
      ...queues,
      screenshotAnalysis: [
        ...queues.screenshotAnalysis.filter((item) => item.sampleId !== sampleId),
        {
          id: createRecordId("screenshot-analysis"),
          sampleId,
          dueAt,
          attempts: 0,
        },
      ],
    }));
    return dueAt;
  }

  function enqueueTaskAnalysis(sampleId: string) {
    // 截图摘要和详细转文字成功后，才把同一份样本送进任务分析队列。
    // 任务分析不直接看原始图片，只看窗口、截图分析文本和任务目标。
    const dueAt = Date.now();
    setRequestQueues((queues) => {
      if (queues.taskAnalysis.some((item) => item.sampleId === sampleId)) {
        return queues;
      }

      return {
        ...queues,
        taskAnalysis: [
          ...queues.taskAnalysis,
          {
            id: createRecordId("task-analysis"),
            sampleId,
            dueAt,
            attempts: 0,
          },
        ],
      };
    });
    return dueAt;
  }

  function createActiveAnalysisWork(
    kind: AnalysisWorkKind,
    item: ScreenshotAnalysisQueueItem | TaskAnalysisQueueItem,
    sample: ContextSampleRecord,
    model: string,
  ): ActiveAnalysisWork {
    // 这份状态只给详情页展示，不参与持久化。
    // 它回答的是“现在正在处理哪条队列项，正在用哪个模型、哪个接口”。
    return {
      kind,
      sampleId: sample.id,
      queueItemId: item.id,
      startedAt: nowLabel(),
      attempts: item.attempts + 1,
      model,
      endpoint: chatCompletionsEndpointLabel(settings.apiUrl),
      screenshotFileName: sample.screenshot?.file_name ?? undefined,
    };
  }

  function apiRequestLogLine(
    stage: string,
    kind: AnalysisWorkKind,
    sample: ContextSampleRecord,
    details: string,
  ) {
    // 只记录可公开排查的信息：时间、阶段、样本、截图文件名、模型、接口和错误摘要。
    // 明确不写 API Key，也不写图片 base64。
    const model =
      kind === "screenshot" ? settings.screenshotModel : settings.navigationModel;
    return [
      nowLabel(),
      `${queueKindLabel(kind)} ${stage}`,
      `样本 ${sample.id}`,
      `截图 ${sample.screenshot?.file_name ?? "未截图"}`,
      `模型 ${model || "未配置"}`,
      `接口 ${chatCompletionsEndpointLabel(settings.apiUrl) || "未配置"}`,
      details,
    ].join("，");
  }

  function queueRetryWaitMs(kind: AnalysisWorkKind) {
    const pausedUntil = queueRetryState[kind].pausedUntil;
    return pausedUntil ? Math.max(0, pausedUntil - Date.now()) : 0;
  }

  function isQueueCoolingDown(kind: AnalysisWorkKind) {
    return queueRetryWaitMs(kind) > 0;
  }

  function clearQueueRetryState(kind: AnalysisWorkKind) {
    setQueueRetryState((current) => ({
      ...current,
      [kind]: {
        failureCount: 0,
        pausedUntil: null,
      },
    }));
  }

  function wakeQueueRetryNow(kind: AnalysisWorkKind) {
    setQueueRetryState((current) => ({
      ...current,
      [kind]: {
        ...current[kind],
        pausedUntil: null,
      },
    }));
    setQueuePaused((current) => ({
      ...current,
      [kind]: false,
    }));
  }

  function recordQueueFailure(
    kind: AnalysisWorkKind,
    item: ScreenshotAnalysisQueueItem | TaskAnalysisQueueItem,
    message: string,
  ) {
    const previousFailureCount = queueRetryState[kind].failureCount;
    const failureCount =
      queueRetryState[kind].lastFailedItemId === item.id
        ? previousFailureCount + 1
        : 1;
    const retryDelay = retryDelayMs(failureCount);
    const pausedUntil = retryDelay > 0 ? Date.now() + retryDelay : null;

    setQueueRetryState((current) => ({
      ...current,
      [kind]: {
        failureCount,
        pausedUntil,
        lastFailedItemId: item.id,
        lastError: message,
      },
    }));

    setRequestQueues((queues) => ({
      ...queues,
      [kind === "screenshot" ? "screenshotAnalysis" : "taskAnalysis"]: queues[
        kind === "screenshot" ? "screenshotAnalysis" : "taskAnalysis"
      ].map((queueItem) =>
        queueItem.id === item.id
          ? {
              ...queueItem,
              attempts: failureCount,
              dueAt: Date.now(),
              lastError: message,
            }
          : queueItem,
      ),
    }));

    return {
      failureCount,
      pausedUntil,
    };
  }

  async function processDueScreenshotAnalysisQueue() {
    // 这个函数由 1 秒轮询驱动，从“已到期队列”里找一条截图分析任务执行。
    if (queuePaused.screenshot) {
      return;
    }

    if (isQueueCoolingDown("screenshot")) {
      return;
    }

    if (screenshotQueueProcessingRef.current) {
      return;
    }

    const item = requestQueues.screenshotAnalysis.find(
      (queueItem) => queueItem.dueAt <= Date.now(),
    );
    if (!item) {
      return;
    }

    const sample = contextSamples.find((record) => record.id === item.sampleId);
    if (!sample) {
      setRequestQueues((queues) => ({
        ...queues,
        screenshotAnalysis: queues.screenshotAnalysis.filter(
          (queueItem) => queueItem.id !== item.id,
        ),
      }));
      return;
    }

    const missingScreenshotMessage = missingScreenshotFileMessage(sample);
    if (missingScreenshotMessage) {
      updateSampleRecord(item.sampleId, {
        screenshotAnalysisStatus: "failed",
        screenshotAnalysis: missingScreenshotMessage,
      });
      updateActivityRecord(item.sampleId, {
        screenshotAnalysis: missingScreenshotMessage,
        analysisBody: missingScreenshotMessage,
        status: "截图分析失败",
      });
      void updateActivityLogAnalysis(sample, missingScreenshotMessage);
      setRequestQueues((queues) => ({
        ...queues,
        screenshotAnalysis: queues.screenshotAnalysis.filter(
          (queueItem) => queueItem.id !== item.id,
        ),
      }));
      return;
    }

    screenshotQueueProcessingRef.current = true;
    // 当前在跑哪张图，详情页直接展示。
    setActiveScreenshotAnalysis(
      createActiveAnalysisWork(
        "screenshot",
        item,
        sample,
        settings.screenshotModel,
      ),
    );
    recordApiRequestLog(
      apiRequestLogLine("开始", "screenshot", sample, `队列项 ${item.id}`),
    );
    try {
      // 先请求截图摘要和详细转文字，再把结果写回活动日志和样本记录，最后再排任务分析。
      const screenshotAnalysis = await analyzeScreenshot(sample);
      recordApiRequestLog(
        apiRequestLogLine("成功", "screenshot", sample, "截图分析响应已解析"),
      );
      clearQueueRetryState("screenshot");
      const screenshotAnalysisText = `截图摘要：${screenshotAnalysis.summary}；任务分析待分析`;
      updateSampleRecord(item.sampleId, {
        screenshotAnalysis: screenshotAnalysis.summary,
        screenshotDetailText: screenshotAnalysis.detailText,
        screenshotAnalysisStatus: "analyzed",
      });
      updateActivityRecord(item.sampleId, {
        screenshotAnalysis: screenshotAnalysis.summary,
        screenshotDetailText: screenshotAnalysis.detailText,
        analysisBody: screenshotAnalysisText,
        status: "截图已分析",
      });
      void updateActivityLogAnalysis(sample, screenshotAnalysisText);
      setRequestQueues((queues) => ({
        ...queues,
        screenshotAnalysis: queues.screenshotAnalysis.filter(
          (queueItem) => queueItem.id !== item.id,
        ),
      }));
      const taskDueAt = enqueueTaskAnalysis(item.sampleId);
      recordApiRequestLog(
        apiRequestLogLine(
          "入队",
          "task",
          sample,
          `截图分析完成后已排队任务分析，预计 ${timeLabelFromTimestamp(taskDueAt)} 开始`,
        ),
      );
    } catch (error) {
      // 网络错误、API Key 错误、模型响应格式错误通常是整条截图分析通道的问题。
      // 因此失败后不让下一张图继续撞 API，而是让截图分析队列整体进入退避等待，再重发刚才这条。
      const message = String(error);
      const retryState = recordQueueFailure("screenshot", item, message);
      const retryText = retryState.pausedUntil
        ? `队列暂停到 ${timeLabelFromTimestamp(retryState.pausedUntil)} 后重发刚才截图`
        : "队列将立即重发刚才截图";
      recordApiRequestLog(
        apiRequestLogLine(
          "失败",
          "screenshot",
          sample,
          `${retryText}，错误 ${message}`,
        ),
      );
      updateSampleRecord(item.sampleId, {
        screenshotAnalysisStatus: "retrying",
        screenshotAnalysis: `截图分析待重试：${retryText}。${message}`,
      });
      updateActivityRecord(item.sampleId, {
        screenshotAnalysis: `截图分析待重试：${retryText}。${message}`,
        analysisBody: `截图分析待重试：${retryText}。${message}`,
        status: "截图分析待重试",
      });
      void updateActivityLogAnalysis(
        sample,
        `截图分析待重试：${retryText}。${message}`,
      );
    } finally {
      // 无论成功失败，都要清空“正在处理”的标记，避免下一轮队列被锁死。
      setActiveScreenshotAnalysis(null);
      screenshotQueueProcessingRef.current = false;
    }
  }

  async function processDueTaskAnalysisQueue() {
    // 任务分析也是轮询拾取的：它只看“到期且还留在队列里”的样本。
    if (queuePaused.task) {
      return;
    }

    if (isQueueCoolingDown("task")) {
      return;
    }

    if (taskQueueProcessingRef.current) {
      return;
    }

    const item = requestQueues.taskAnalysis.find(
      (queueItem) => queueItem.dueAt <= Date.now(),
    );
    if (!item) {
      return;
    }

    const sample = contextSamples.find((record) => record.id === item.sampleId);
    if (!sample) {
      setRequestQueues((queues) => ({
        ...queues,
        taskAnalysis: queues.taskAnalysis.filter(
          (queueItem) => queueItem.id !== item.id,
        ),
      }));
      return;
    }

    taskQueueProcessingRef.current = true;
    // 详情页展示当前任务分析请求。
    setActiveTaskAnalysis(
      createActiveAnalysisWork(
        "task",
        item,
        sample,
        settings.navigationModel,
      ),
    );
    recordApiRequestLog(
      apiRequestLogLine("开始", "task", sample, `队列项 ${item.id}`),
    );
    try {
      // 任务分析拿到的是结构化 JSON 结果，成功后会继续驱动通知气泡。
      const analysis = await analyzeSampleWithAi(sample);
      recordApiRequestLog(
        apiRequestLogLine("成功", "task", sample, "任务分析响应已通过结构校验"),
      );
      clearQueueRetryState("task");
      updateSampleRecord(item.sampleId, {
        taskAnalysisStatus: "analyzed",
      });
      updateActivityRecord(item.sampleId, {
        analysisBody: analysis.body,
        status: "已分析",
      });
      void updateActivityLogAnalysis(sample, analysis.body);
      setAnalysisResults((records) => [analysis, ...records]);
      triggerScenario(notificationFromAnalysis(analysis));
      setRequestQueues((queues) => ({
        ...queues,
        taskAnalysis: queues.taskAnalysis.filter(
          (queueItem) => queueItem.id !== item.id,
        ),
      }));
    } catch (error) {
      // 任务分析失败也按“队列级问题”处理：暂停整条任务分析队列，再重发刚才这条。
      const message = String(error);
      const retryState = recordQueueFailure("task", item, message);
      const retryText = retryState.pausedUntil
        ? `队列暂停到 ${timeLabelFromTimestamp(retryState.pausedUntil)} 后重发刚才任务分析`
        : "队列将立即重发刚才任务分析";
      recordApiRequestLog(
        apiRequestLogLine(
          "失败",
          "task",
          sample,
          `${retryText}，错误 ${message}`,
        ),
      );
      updateSampleRecord(item.sampleId, {
        taskAnalysisStatus: "retrying",
        error: `任务分析待重试：${retryText}。${message}`,
      });
      updateActivityRecord(item.sampleId, {
        analysisBody: `任务分析待重试：${retryText}。${message}`,
        status: "任务分析待重试",
      });
      void updateActivityLogAnalysis(
        sample,
        `任务分析待重试：${retryText}。${message}`,
      );
    } finally {
      // 释放任务队列处理标记，让下一轮轮询继续接管。
      setActiveTaskAnalysis(null);
      taskQueueProcessingRef.current = false;
    }
  }

  function updateSampleRecord(
    sampleId: string,
    updates: Partial<ContextSampleRecord>,
  ) {
    setContextSamples((records) =>
      records.map((record) =>
        record.id === sampleId ? { ...record, ...updates } : record,
      ),
    );
  }

  function updateActivityRecord(
    sampleId: string,
    updates: Partial<ActivityLogRecord>,
  ) {
    setActivityLogRecords((records) =>
      records.map((record) =>
        record.sampleId === sampleId ? { ...record, ...updates } : record,
      ),
    );
  }

  async function updateActivityLogAnalysis(
    sample: ContextSampleRecord,
    analysis: string,
  ) {
    // 截图分析或任务分析完成后，把最终结果回写到 activity-log.md 对应行。
    const screenshotLabelText = screenshotLabel(sample.screenshot);
    await invoke("update_activity_log_analysis", {
      update: {
        screenshot_label: screenshotLabelText,
        analysis,
      },
    });
    if (page === "details") {
      void refreshActivityLog();
    }
  }

  function recordNotification(
    scenario: NotificationScenario,
    result: NotificationRecord["result"],
    correction?: string,
  ) {
    setNotificationRecords((records) => [
      {
        scenario: scenario.scenario,
        notifyType: scenario.notify_type,
        body: scenario.body,
        result,
        correction,
        recordedAt: nowLabel(),
      },
      ...records,
    ]);
  }

  function recordInputEvent(
    eventType: InputEventRecord["eventType"],
    source: InputEventRecord["source"],
  ) {
    setInputEventRecords((records) => [
      {
        eventType,
        recordedAt: nowLabel(),
        source,
      },
      ...records,
    ]);
  }

  function applyStoredState(state: StoredAppState) {
    // 页面初始化时把 SQLite/localStorage 中的运行态恢复回来。
    setTask(state.task);
    setMode(state.task ? "task_tracking" : "silent_companion");
    setNotificationRecords(state.notificationRecords);
    setInputEventRecords(state.inputEventRecords);
    setActivityLogRecords(state.activityLogRecords);
    setRequestQueues(state.requestQueues);
    setContextSamples(state.contextSamples);
    setAnalysisResults(state.analysisResults);
    setSummary(state.summary);
    setActiveNotification(null);
  }

  function updateSettings(nextSettings: Settings) {
    // 只更新内存里的 AI 设置，不立即碰磁盘；真正保存走 saveAiSettings。
    latestSettingsRef.current = nextSettings;
    setSettings(nextSettings);
    setAiSettingsSaveStatus("idle");
  }

  function updateApiKey(nextApiKey: string) {
    // API Key 也是单独保存的私密字段，和应用监控权限不共用保存按钮。
    latestApiKeyRef.current = nextApiKey;
    setApiKey(nextApiKey);
    setAiSettingsSaveStatus("idle");
  }

  async function saveAiSettings(
    nextSettings = latestSettingsRef.current,
    nextApiKey = latestApiKeyRef.current,
  ) {
    // 只保存 URL / Key / 模型，不带 appPermissions。
    setAiSettingsSaveStatus("saving");
    const saveFingerprint = aiSettingsFingerprint(
      nextSettings,
      nextApiKey,
    );

    const privateSettings = {
      api_url: nextSettings.apiUrl,
      api_key: nextApiKey,
      screenshot_model: nextSettings.screenshotModel,
      navigation_model: nextSettings.navigationModel,
    };

    aiSettingsSaveChainRef.current = aiSettingsSaveChainRef.current
      .catch(() => undefined)
      .then(() => {
        const currentFingerprint = aiSettingsFingerprint(
          latestSettingsRef.current,
          latestApiKeyRef.current,
        );
        if (currentFingerprint !== saveFingerprint) {
          return undefined;
        }

        return invoke("save_ai_private_settings", { update: privateSettings });
      })
      .then(
        () => {
          setAiSettingsSaveStatus("saved");
        },
        (error) => {
          console.warn("Could not save AI private settings", error);
          setAiSettingsSaveStatus("error");
        },
      );

    await aiSettingsSaveChainRef.current;
  }

  async function saveAppPermissions(
    nextAppPermissions = latestSettingsRef.current.appPermissions,
  ) {
    // 只保存应用监控权限，不覆盖 API URL / API Key / 模型。
    setAppPermissionsSaveStatus("saving");
    const normalizedAppPermissions = normalizeAppPermissions(nextAppPermissions);
    const saveFingerprint = appPermissionsFingerprint(normalizedAppPermissions);
    const update = {
      app_permissions: normalizedAppPermissions,
    };

    appPermissionsSaveChainRef.current = appPermissionsSaveChainRef.current
      .catch(() => undefined)
      .then(() => {
        const currentFingerprint = appPermissionsFingerprint(
          latestSettingsRef.current.appPermissions,
        );
        if (currentFingerprint !== saveFingerprint) {
          return undefined;
        }

        return invoke("save_app_permissions", { update });
      })
      .then(
        () => {
          setAppPermissionsSaveStatus("saved");
        },
        (error) => {
          console.warn("Could not save app permissions", error);
          setAppPermissionsSaveStatus("error");
        },
      );

    await appPermissionsSaveChainRef.current;
  }

  function clickCorrection(scenario: NotificationScenario) {
    const correction =
      scenario.button === "actually_related" ? "这其实相关" : "这其实很重要";
    recordNotification(scenario, "correction_clicked", correction);
    setActiveNotification(null);
  }

  function endTask() {
    const confirmed = window.confirm("确定结束当前任务吗？");
    if (!confirmed) {
      return;
    }

    setTask(null);
    setMode("silent_companion");
    setSummary(null);
    setActiveNotification(null);
  }

  function resetDemoData() {
    const confirmed = window.confirm("确定清空本机运行记录吗？API URL、API Key、模型和应用列表会保留。");
    if (!confirmed) {
      return;
    }

    window.localStorage.removeItem(storageKey);
    setMode("silent_companion");
    setTask(null);
    setDraftTask({ goal: "", deadline: "", notes: "" });
    setActiveNotification(null);
    setNotificationRecords([]);
    setInputEventRecords([]);
    setRequestQueues(defaultStoredState.requestQueues);
    setContextSamples([]);
    setAnalysisResults([]);
    setSummary(null);
  }

  async function refreshWindowSnapshot() {
    try {
      setWindowSnapshotError("");
      const snapshot = await invoke<ForegroundWindowSnapshot>(
        "get_foreground_window_snapshot",
      );
      setWindowSnapshot(snapshot);
    } catch (error) {
      setWindowSnapshotError(String(error));
    }
  }

  async function refreshActivityLog() {
    try {
      setActivityLogError("");
      const content = await invoke<string>("load_activity_log");
      setActivityLogContent(content);
    } catch (error) {
      setActivityLogError(String(error));
    }
  }

  async function refreshApiRequestLog() {
    // 详情页手动刷新 API 请求日志。日志文件可能被后台队列异步追加，所以这里按需重读磁盘。
    try {
      setApiRequestLogError("");
      const content = await invoke<string>("load_api_request_log");
      setApiRequestLogContent(content);
    } catch (error) {
      setApiRequestLogError(String(error));
    }
  }

  function recordApiRequestLog(line: string) {
    // API 请求日志写到独立文件，专门排查“有没有发请求、发到哪、返回了什么”。
    // 这里不写入 API Key，也不写入图片内容。
    void invoke("append_api_request_log_line", { entry: { line } })
      .then(() => {
        if (page === "details") {
          void refreshApiRequestLog();
        }
      })
      .catch((error) => {
        console.warn("Could not append API request log", error);
      });
  }

  async function captureContextSample(
    trigger: ContextSampleRecord["trigger"] = "manual_button",
  ) {
    // 一次上下文采样的完整流程：
    // 1. 读取当前前台窗口；
    // 2. 检查这个应用是否允许截图；
    // 3. 允许则调用 Rust 保存本机截图；
    // 4. 写 activity-log.md；
    // 5. 将截图样本放入截图分析队列。
    lastScreenshotAttemptAtRef.current = Date.now();
    try {
      setWindowSnapshotError("");
      setScreenshotError("");
      const snapshot = await invoke<ForegroundWindowSnapshot>(
        "get_foreground_window_snapshot",
      );

      setWindowSnapshot(snapshot);
      if (isShellOnlyForegroundSnapshot(snapshot)) {
        setScreenshotResult(null);
        return;
      }

      if (!canSampleApp(snapshot, settings.appPermissions)) {
        // 未加入监控或未确认的新应用不能截图，只记录“已跳过截图”。
        // 这个分支不会进入 API 请求队列。
        const runtimePermission = permissionFromSnapshot(snapshot);
        const existingPermission = findAppPermission(
          snapshot,
          settings.appPermissions,
        );
        const blockReason = existingPermission
          ? existingPermission.user_confirmed
            ? `${existingPermission.app_name} 已在设置中关闭监控。`
            : `${existingPermission.app_name} 尚未在设置中确认允许监控。`
          : `${runtimePermission.app_name} 是新发现应用，已加入待确认列表。`;
        const sample: ContextSampleRecord = {
          id: createRecordId("sample"),
          recordedAt: nowLabel(),
          trigger,
          taskGoal: task?.goal ?? "未开始任务",
          window: snapshot,
          screenshot: null,
          error: `已跳过截图：${blockReason}`,
        };

        if (!existingPermission) {
          ensureRuntimeAppPermission(snapshot);
        }

        setScreenshotResult(null);
        setContextSamples((records) => [
          sample,
          ...records,
        ]);
        const analysis = analyzeContextSample(sample);
        setAnalysisResults((records) => [analysis, ...records]);
        recordSampleActivity(sample, analysis, blockReason);
        return;
      }

      const screenshot = await invoke<ScreenshotCaptureResult>(
        "capture_screenshot_snapshot",
      );
      // 截图成功只是“图片已落盘”；真正理解截图还要等截图分析队列处理。
      setScreenshotResult(screenshot);
      const sample: ContextSampleRecord = {
        id: createRecordId("sample"),
        recordedAt: nowLabel(),
        trigger,
        taskGoal: task?.goal ?? "未开始任务",
        window: snapshot,
        screenshot,
        screenshotAnalysisStatus: "pending",
        taskAnalysisStatus: "pending",
      };
      setContextSamples((records) => [
        sample,
        ...records,
      ]);
      recordSampleActivity(sample, pendingAnalysisResult(sample), "截图未分析");
      const dueAt = scheduleScreenshotAnalysis(sample.id);
      recordApiRequestLog(
        apiRequestLogLine(
          "入队",
          "screenshot",
          sample,
          `预计 ${timeLabelFromTimestamp(dueAt)} 后开始请求`,
        ),
      );
    } catch (error) {
      const message = String(error);
      setScreenshotError(message);
      const sample: ContextSampleRecord = {
        id: createRecordId("sample"),
        recordedAt: nowLabel(),
        trigger,
        taskGoal: task?.goal ?? "未开始任务",
        window: null,
        screenshot: null,
        error: message,
      };
      setContextSamples((records) => [
        sample,
        ...records,
      ]);
      const analysis = analyzeContextSample(sample);
      setAnalysisResults((records) => [analysis, ...records]);
      recordSampleActivity(sample, analysis, message);
    }
  }

  captureContextSampleRef.current = captureContextSample;

  async function analyzeScreenshot(sample: ContextSampleRecord) {
    // 截图理解请求。这里要求截图文件、API URL、API Key、截图模型全部存在。
    // Rust 侧会把图片转成 base64 data URL 并调用 OpenAI 兼容 chat completions。
    if (!sample.screenshot?.file_path) {
      throw new Error("没有可用于分析的截图文件。");
    }

    if (
      !settings.apiUrl.trim() ||
      !apiKey.trim() ||
      !settings.screenshotModel.trim()
    ) {
      throw new Error("未配置截图理解模型或 API 信息。");
    }

    const request: ScreenshotAnalysisRequest = {
      api_url: settings.apiUrl,
      api_key: apiKey,
      model: settings.screenshotModel,
      screenshot_path: sample.screenshot.file_path,
      context_json: JSON.stringify({
        taskGoal: sample.taskGoal,
        window: sample.window,
        screenshot: sample.screenshot,
      }),
    };
    return await invoke<ScreenshotAnalysisResult>("analyze_screenshot_with_ai", {
      request,
    });
  }

  async function analyzeSampleWithAi(sample: ContextSampleRecord) {
    // 任务导航请求。它不直接上传原图，而是上传包含截图摘要和详细转文字的 sample JSON，
    // 并要求模型返回符合 analysisResultSchema 的结构化 JSON。
    if (
      !settings.apiUrl.trim() ||
      !apiKey.trim() ||
      !settings.navigationModel.trim()
    ) {
      throw new Error("未配置任务导航模型或 API 信息。");
    }

    const request: AiAnalysisRequest = {
      api_url: settings.apiUrl,
      api_key: apiKey,
      model: settings.navigationModel,
      context_json: JSON.stringify(sample),
      schema_json: JSON.stringify(analysisResultSchema),
    };
    const rawResult = await invoke<string>("analyze_context_with_ai", {
      request,
    });
    return validateAnalysisResult(JSON.parse(rawResult));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <strong>SuperGuider</strong>
            <small>Task guidance demo</small>
          </div>
        </div>

        <button
          className={page === "status" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("status")}
        >
          状态
        </button>
        <button
          className={page === "details" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("details")}
        >
          详情
        </button>
        <button
          className={page === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("settings")}
        >
          设置
          {!initialized && <span className="warning-dot">!</span>}
        </button>
      </aside>

      <section className="panel">
        {page === "status" ? (
          <StatusPage
            mode={mode}
            task={task}
            draftTask={draftTask}
            setDraftTask={setDraftTask}
            createTask={createTask}
            plan={referencePlan}
            triggerScenario={triggerScenario}
            notificationRecords={notificationRecords}
            inputEventRecords={inputEventRecords}
            contextSamples={contextSamples}
            analysisResults={analysisResults}
            summary={summary}
            endTask={endTask}
            windowSnapshot={windowSnapshot}
            windowSnapshotError={windowSnapshotError}
            refreshWindowSnapshot={refreshWindowSnapshot}
            screenshotResult={screenshotResult}
            screenshotError={screenshotError}
            captureContextSample={captureContextSample}
          />
        ) : page === "details" ? (
          <DetailsPage
            settings={settings}
            activityLogPath={activityLogPath}
            activityLogContent={activityLogContent}
            activityLogError={activityLogError}
            apiRequestLogPath={apiRequestLogPath}
            apiRequestLogContent={apiRequestLogContent}
            apiRequestLogError={apiRequestLogError}
            requestQueues={requestQueues}
            contextSamples={contextSamples}
            activeScreenshotAnalysis={activeScreenshotAnalysis}
            activeTaskAnalysis={activeTaskAnalysis}
            queuePaused={queuePaused}
            queueRetryState={queueRetryState}
            detailsTimeRange={detailsTimeRange}
            updateDetailsTimeRange={updateDetailsTimeRange}
            setDetailsRangeToday={setDetailsRangeToday}
            setQueuePaused={setQueuePaused}
            wakeQueueRetryNow={wakeQueueRetryNow}
            refreshActivityLog={refreshActivityLog}
            refreshApiRequestLog={refreshApiRequestLog}
          />
        ) : (
          <SettingsPage
            settings={settings}
            setSettings={updateSettings}
            apiKey={apiKey}
            setApiKey={updateApiKey}
            saveAiSettings={saveAiSettings}
            saveAppPermissions={saveAppPermissions}
            aiSettingsSaveStatus={aiSettingsSaveStatus}
            appPermissionsSaveStatus={appPermissionsSaveStatus}
            databaseLoaded={databaseLoaded}
            resetDemoData={resetDemoData}
            activityLogPath={activityLogPath}
          />
        )}
      </section>

      {activeNotification && (
        <NotificationOrb
          notification={activeNotification}
          onHoverChange={setHoveringNotification}
          onCorrection={() => clickCorrection(activeNotification)}
        />
      )}
    </main>
  );
}

function StatusPage({
  mode,
  task,
  draftTask,
  setDraftTask,
  createTask,
  plan,
  triggerScenario,
  notificationRecords,
  inputEventRecords,
  contextSamples,
  analysisResults,
  summary,
  endTask,
  windowSnapshot,
  windowSnapshotError,
  refreshWindowSnapshot,
  screenshotResult,
  screenshotError,
  captureContextSample,
}: {
  mode: AppMode;
  task: Task | null;
  draftTask: Task;
  setDraftTask: (task: Task) => void;
  createTask: () => void;
  plan: ReferencePlan;
  triggerScenario: (scenario: NotificationScenario) => void;
  notificationRecords: NotificationRecord[];
  inputEventRecords: InputEventRecord[];
  contextSamples: ContextSampleRecord[];
  analysisResults: AnalysisResult[];
  summary: TaskSummary | null;
  endTask: () => void;
  windowSnapshot: ForegroundWindowSnapshot | null;
  windowSnapshotError: string;
  refreshWindowSnapshot: () => void;
  screenshotResult: ScreenshotCaptureResult | null;
  screenshotError: string;
  captureContextSample: () => void;
}) {
  if (!task) {
    return (
      <div className="page-grid">
        <section className="hero-card">
          <p className="eyebrow">当前状态</p>
          <h1>{mode === "silent_companion" ? "静默陪伴" : "任务追踪"}</h1>
          <p>
            现在还没有进行中的任务。第一版 demo 会先用内置场景数据
            跑通任务创建、提示气泡和结束总结。
          </p>
        </section>

        {summary && (
          <section className="card">
            <p className="eyebrow">上次总结</p>
            <h2>{summary.summary_text}</h2>
            <ul className="soft-list">
              {summary.time_breakdown.map((item) => (
                <li key={item.topic}>
                  <span>{item.topic}</span>
                  <strong>{item.duration_minutes} min</strong>
                </li>
              ))}
            </ul>
            <p className="muted">{summary.final_observation}</p>
          </section>
        )}

        <section className="card">
          <p className="eyebrow">开启任务追踪</p>
          <label>
            任务描述
            <input
              value={draftTask.goal}
              onChange={(event) =>
                setDraftTask({ ...draftTask, goal: event.currentTarget.value })
              }
              placeholder="例如：今晚前跑通 SuperGuider 最小 Demo"
            />
          </label>
          <label>
            截止时间
            <input
              type="datetime-local"
              value={draftTask.deadline}
              onChange={(event) =>
                setDraftTask({
                  ...draftTask,
                  deadline: event.currentTarget.value,
                })
              }
            />
          </label>
          <label>
            补充说明
            <textarea
              value={draftTask.notes}
              onChange={(event) =>
                setDraftTask({ ...draftTask, notes: event.currentTarget.value })
              }
              placeholder="可选：当前阶段、提醒严格程度、特别想避免的坑"
            />
          </label>
          <button className="primary-button" onClick={createTask}>
            开始任务
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="page-grid">
      <section className="hero-card">
        <p className="eyebrow">当前状态</p>
        <h1>任务追踪</h1>
        <p>{task.goal}</p>
        <div className="meta-row">
          <span>截止时间</span>
          <strong>{task.deadline.replace("T", " ")}</strong>
        </div>
      </section>

      <section className="card wide">
        <p className="eyebrow">参考任务拆解</p>
        <h2>{plan.body}</h2>
        <div className="stage-list">
          {plan.reference_stages.map((stage) => (
            <article className="stage-card" key={stage.stage_id}>
              <span>{stage.minimum_estimated_minutes} min</span>
              <h3>{stage.stage_title}</h3>
              <p>{stage.stage_goal}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">场景分析</p>
        <h2>先用假答案跑通提示闭环</h2>
        <div className="button-grid">
          <button onClick={() => triggerScenario(notificationScenarios.stuck)}>
            触发卡住
          </button>
          <button onClick={() => triggerScenario(notificationScenarios.offTrack)}>
            触发偏航
          </button>
          <button onClick={() => triggerScenario(notificationScenarios.overOptimizing)}>
            触发过度优化
          </button>
          <button onClick={() => triggerScenario(notificationScenarios.noNotify)}>
            不提示
          </button>
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">系统能力入口</p>
        <h2>Rust 窗口快照</h2>
        <p className="muted">
          这一步先返回占位数据，用来验证 TypeScript 能调用 Rust command。
        </p>
        <button className="primary-button" onClick={refreshWindowSnapshot}>
          读取当前窗口快照
        </button>
        {windowSnapshot && (
          <dl className="snapshot-list">
            <div>
              <dt>应用</dt>
              <dd>{windowSnapshot.app_name}</dd>
            </div>
            <div>
              <dt>进程</dt>
              <dd>{windowSnapshot.process_name}</dd>
            </div>
            <div>
              <dt>标题</dt>
              <dd>{windowSnapshot.window_title}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{windowSnapshot.source}</dd>
            </div>
          </dl>
        )}
        {windowSnapshotError && (
          <p className="error-text">{windowSnapshotError}</p>
        )}
      </section>

      <section className="card">
        <p className="eyebrow">输入事件</p>
        <h2>全局 Enter / Ctrl+C</h2>
        <p className="muted">
          当前优先使用 Windows 全局键盘监听，前端窗口监听保留为兜底。Enter 和 Ctrl+C 会在已加入监控的应用中触发一次本机截图。
        </p>
        {inputEventRecords.length === 0 ? (
          <p className="muted">还没有输入事件。</p>
        ) : (
          <ul className="record-list">
            {inputEventRecords.slice(0, 5).map((record, index) => (
              <li key={`${record.recordedAt}-${record.eventType}-${index}`}>
                <strong>{record.eventType}</strong>
                <span>{record.source}</span>
                <small>{record.recordedAt}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <p className="eyebrow">截图能力入口</p>
        <h2>上下文采样</h2>
        <p className="muted">
          当前会同时读取前台窗口和本机截图结果，形成一条 AI 输入骨架；稳定前台切换、键盘事件和最长三分钟兜底都会触发采样，截图会保存到 %LOCALAPPDATA%\SuperGuider\screenshots。
        </p>
        <button className="primary-button" onClick={() => captureContextSample()}>
          采样当前上下文
        </button>
        {screenshotResult && (
          <dl className="snapshot-list">
            <div>
              <dt>状态</dt>
              <dd>{screenshotResult.status}</dd>
            </div>
            <div>
              <dt>原因</dt>
              <dd>{screenshotResult.reason}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{screenshotResult.source}</dd>
            </div>
            <div>
              <dt>尺寸</dt>
              <dd>
                {screenshotResult.width} x {screenshotResult.height}
              </dd>
            </div>
            {screenshotResult.file_path && (
              <div>
                <dt>路径</dt>
                <dd>{screenshotResult.file_path}</dd>
              </div>
            )}
          </dl>
        )}
        {screenshotError && <p className="error-text">{screenshotError}</p>}
      </section>

      <section className="card wide">
        <p className="eyebrow">上下文采样记录</p>
        <h2>最近一次 AI 输入骨架</h2>
        {contextSamples.length === 0 ? (
          <p className="muted">
            还没有采样记录。点击“采样当前上下文”、按 Enter / Ctrl+C，或切换到已加入监控的应用后停留 3 秒试一次。
          </p>
        ) : (
          <ul className="context-list">
            {contextSamples.slice(0, 3).map((sample, index) => (
              <li key={`${sample.recordedAt}-${index}`}>
                <div className="context-head">
                  <strong>{sample.trigger}</strong>
                  <small>{sample.recordedAt}</small>
                </div>
                <p>{sample.taskGoal}</p>
                {sample.window && (
                  <span>
                    {sample.window.app_name} / {sample.window.window_title}
                  </span>
                )}
                {sample.screenshot && (
                  <span>
                    {sample.screenshot.status} · {sample.screenshot.width} x{" "}
                    {sample.screenshot.height}
                    {sample.screenshot.file_name
                      ? ` · ${sample.screenshot.file_name}`
                      : ""}
                  </span>
                )}
                {sample.screenshotAnalysis && (
                  <span>截图摘要：{sample.screenshotAnalysis}</span>
                )}
                {sample.screenshotDetailText && (
                  <details className="context-detail">
                    <summary>截图详细转文字</summary>
                    <p>{sample.screenshotDetailText}</p>
                  </details>
                )}
                {sample.error && <em>{sample.error}</em>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <p className="eyebrow">分析结果</p>
        <h2>AI 优先，本地兜底</h2>
        {analysisResults.length === 0 ? (
          <p className="muted">还没有分析结果。完成一次上下文采样后会自动生成。</p>
        ) : (
          <ul className="analysis-list">
            {analysisResults.slice(0, 3).map((result, index) => (
              <li key={`${result.recordedAt}-${index}`}>
                <strong>{result.should_notify ? "提示" : "不提示"}</strong>
                <span>{result.notify_type}</span>
                <p>{result.body}</p>
                <small>{result.basis}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <p className="eyebrow">最近提示记录</p>
        {notificationRecords.length === 0 ? (
          <p className="muted">还没有提示记录。</p>
        ) : (
          <ul className="record-list">
            {notificationRecords.slice(0, 5).map((record, index) => (
              <li key={`${record.recordedAt}-${index}`}>
                <strong>{record.result}</strong>
                <span>{record.notifyType}</span>
                <small>{record.recordedAt}</small>
                {record.correction && <em>{record.correction}</em>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="footer-actions">
        <button className="ghost-button" onClick={endTask}>
          结束任务
        </button>
      </section>
    </div>
  );
}

function DetailsPage({
  settings,
  activityLogPath,
  activityLogContent,
  activityLogError,
  apiRequestLogPath,
  apiRequestLogContent,
  apiRequestLogError,
  requestQueues,
  contextSamples,
  activeScreenshotAnalysis,
  activeTaskAnalysis,
  queuePaused,
  queueRetryState,
  detailsTimeRange,
  updateDetailsTimeRange,
  setDetailsRangeToday,
  setQueuePaused,
  wakeQueueRetryNow,
  refreshActivityLog,
  refreshApiRequestLog,
}: {
  settings: Settings;
  activityLogPath: string;
  activityLogContent: string;
  activityLogError: string;
  apiRequestLogPath: string;
  apiRequestLogContent: string;
  apiRequestLogError: string;
  requestQueues: RequestQueues;
  contextSamples: ContextSampleRecord[];
  activeScreenshotAnalysis: ActiveAnalysisWork | null;
  activeTaskAnalysis: ActiveAnalysisWork | null;
  queuePaused: QueuePauseState;
  queueRetryState: QueueRetryState;
  detailsTimeRange: { start: string; end: string };
  updateDetailsTimeRange: (
    updates: Partial<{ start: string; end: string }>,
  ) => void;
  setDetailsRangeToday: () => void;
  setQueuePaused: React.Dispatch<React.SetStateAction<QueuePauseState>>;
  wakeQueueRetryNow: (kind: AnalysisWorkKind) => void;
  refreshActivityLog: () => void;
  refreshApiRequestLog: () => void;
}) {
  const rows = parseActivityLogTable(activityLogContent);
  const rangeStartMs = detailsTimeRange.start
    ? new Date(detailsTimeRange.start).getTime()
    : Number.NEGATIVE_INFINITY;
  const rangeEndMs = detailsTimeRange.end
    ? new Date(detailsTimeRange.end).getTime()
    : Number.POSITIVE_INFINITY;
  const legacyRows = rows.filter((row) => !row.timestampMs).length;
  const filteredRows = rows.filter((row) => {
    if (!row.timestampMs) {
      return false;
    }

    return row.timestampMs >= rangeStartMs && row.timestampMs <= rangeEndMs;
  });
  const rangeLabel = `${detailsTimeRange.start || "不限"} 到 ${
    detailsTimeRange.end || "不限"
  }`;
  const samplesById = new Map(contextSamples.map((sample) => [sample.id, sample]));
  const [openScreenshotPopover, setOpenScreenshotPopover] = useState<string | null>(
    null,
  );
  const apiLogLines = apiRequestLogContent
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("格式："))
    .slice(-80)
    .reverse();

  function renderActiveWork(work: ActiveAnalysisWork | null, emptyText: string) {
    // 这一块只展示“当前正在跑的请求”，方便你快速判断是不是卡在网络或 API 错误上。
    if (!work) {
      return <span className="muted">{emptyText}</span>;
    }

    return (
      <>
        <strong>{queueKindLabel(work.kind)}请求中</strong>
        <span>样本：{work.sampleId}</span>
        <span>截图：{work.screenshotFileName ?? "未截图"}</span>
        <span>模型：{work.model || "未配置"}</span>
        <span>接口：{work.endpoint || "未配置"}</span>
        <small>
          开始：{work.startedAt} · 第 {work.attempts} 次尝试
        </small>
      </>
    );
  }

  function screenshotSampleForRow(row: ActivityLogTableRow) {
    if (!row.screenshot) {
      return null;
    }

    return (
      contextSamples.find((sample) => {
        const fileName = sample.screenshot?.file_name;
        return fileName ? row.screenshot.includes(fileName) : false;
      }) ?? null
    );
  }

  function renderScreenshotCell(row: ActivityLogTableRow) {
    const sample = screenshotSampleForRow(row);
    const hasAnalysis = Boolean(
      sample?.screenshotAnalysis || sample?.screenshotDetailText,
    );

    if (!row.screenshot) {
      return null;
    }

    if (!hasAnalysis) {
      return row.screenshot;
    }

    const isOpen = openScreenshotPopover === row.id;

    return (
      <div
        className="screenshot-cell"
        onMouseLeave={() => setOpenScreenshotPopover(null)}
      >
        <button
          className="screenshot-link-button"
          onClick={() => setOpenScreenshotPopover(isOpen ? null : row.id)}
          type="button"
        >
          {row.screenshot}
        </button>
        {isOpen && (
          <div className="screenshot-popover">
            <strong>截图摘要</strong>
            <p>{sample?.screenshotAnalysis || "暂无摘要。"}</p>
            <strong>详细说明</strong>
            <p>{sample?.screenshotDetailText || "暂无详细说明。"}</p>
          </div>
        )}
      </div>
    );
  }

  function isRowBlockedByAppPermission(row: ActivityLogTableRow) {
    if (!row.rawApp.trim()) {
      return false;
    }

    const permission = findAppPermission(
      {
        app_name: row.rawApp,
        process_name: row.rawApp,
        window_title: row.rawWindowTitle,
        source: "activity_log",
      },
      settings.appPermissions,
    );

    return Boolean(
      permission && (!permission.user_confirmed || !permission.monitor_enabled),
    );
  }

  function renderQueueItems(
    kind: AnalysisWorkKind,
    items: Array<ScreenshotAnalysisQueueItem | TaskAnalysisQueueItem>,
  ) {
    // 这块展示的是“还没轮到执行的队列项”，和上面的“正在处理”状态分开看。
    if (items.length === 0) {
      return <li className="queue-empty">当前没有排队项。</li>;
    }

    return items.map((item) => {
      const sample = samplesById.get(item.sampleId);
      const retryState = queueRetryState[kind];
      const isBlockedByQueueRetry =
        retryState.lastFailedItemId === item.id &&
        retryState.pausedUntil &&
        retryState.pausedUntil > Date.now();
      const waitingLabel =
        isBlockedByQueueRetry
          ? `队列冷却到 ${timeLabelFromTimestamp(retryState.pausedUntil!)} 后重发这条`
          : item.dueAt <= Date.now()
          ? "已到时间，等待处理循环拾取"
          : `等待到 ${timeLabelFromTimestamp(item.dueAt)}`;

      return (
        <li className="queue-item" key={item.id}>
          <strong>{sample ? sampleSummaryLabel(sample) : "样本已不存在"}</strong>
          <span>{queueKindLabel(kind)} · 队列项 {item.id}</span>
          <small>
            第 {item.attempts + 1} 次尝试 · {waitingLabel}
          </small>
          {item.lastError && <em>{item.lastError}</em>}
        </li>
      );
    });
  }

  function toggleQueuePaused(kind: AnalysisWorkKind) {
    setQueuePaused((current) => ({
      ...current,
      [kind]: !current[kind],
    }));
  }

  function renderQueueHeader(kind: AnalysisWorkKind, title: string) {
    const paused = queuePaused[kind];
    const retryState = queueRetryState[kind];
    const retrying =
      retryState.pausedUntil && retryState.pausedUntil > Date.now();
    const actionLabel = retrying ? "立即重发" : paused ? "开始" : "暂停";

    return (
      <div className="queue-column-titlebar">
        <div className="queue-column-title">
          <h3>{title}</h3>
          {retrying ? (
            <small>
              API 失败冷却中，到 {timeLabelFromTimestamp(retryState.pausedUntil!)} 重发刚才这条
            </small>
          ) : retryState.failureCount > 0 ? (
            <small>上次失败后会先重发刚才这条</small>
          ) : null}
        </div>
        <div className="queue-column-actions">
          <button
            className={`queue-toggle-button ${paused || retrying ? "paused" : ""}`}
            onClick={() =>
              retrying ? wakeQueueRetryNow(kind) : toggleQueuePaused(kind)
            }
            type="button"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    );
  }

  function queueStatusLabel(kind: AnalysisWorkKind, activeWork: ActiveAnalysisWork | null) {
    const retryState = queueRetryState[kind];
    if (queuePaused[kind]) {
      return `${queueKindLabel(kind)}手动暂停`;
    }

    if (retryState.pausedUntil && retryState.pausedUntil > Date.now()) {
      return `${queueKindLabel(kind)}失败冷却到 ${timeLabelFromTimestamp(
        retryState.pausedUntil,
      )}`;
    }

    return activeWork ? `${queueKindLabel(kind)}请求中` : `${queueKindLabel(kind)}空闲`;
  }

  return (
    <div className="page-grid">
      <section className="card wide">
        <p className="eyebrow">请求队列</p>
        <h2>截图与任务分析进度</h2>
        <p className="muted">
          这里显示内存中的分析队列。截图先进入截图分析队列，截图摘要和详细转文字成功后再进入任务分析队列。
        </p>
        <div className="queue-summary">
          <span>截图分析排队 {requestQueues.screenshotAnalysis.length} 个</span>
          <span>任务分析排队 {requestQueues.taskAnalysis.length} 个</span>
          <span>{queueStatusLabel("screenshot", activeScreenshotAnalysis)}</span>
          <span>{queueStatusLabel("task", activeTaskAnalysis)}</span>
        </div>
        <div className="queue-active-grid">
          <div className="queue-active">
            {renderActiveWork(activeScreenshotAnalysis, "当前没有正在请求的截图分析。")}
          </div>
          <div className="queue-active">
            {renderActiveWork(activeTaskAnalysis, "当前没有正在请求的任务分析。")}
          </div>
        </div>
        <div className="queue-columns">
          <div className="queue-column">
            {renderQueueHeader("screenshot", "截图分析队列")}
            <ul className="queue-list">
              {renderQueueItems("screenshot", requestQueues.screenshotAnalysis)}
            </ul>
          </div>
          <div className="queue-column">
            {renderQueueHeader("task", "任务分析队列")}
            <ul className="queue-list">
              {renderQueueItems("task", requestQueues.taskAnalysis)}
            </ul>
          </div>
        </div>
      </section>

      <section className="card wide">
        <p className="eyebrow">API 请求日志</p>
        <h2>分析接口请求记录</h2>
        <p className="muted">
          数据来自 {apiRequestLogPath || "%LOCALAPPDATA%\\SuperGuider\\api-request-log.md"}。日志不会记录 API Key，也不会记录图片 base64。
        </p>
        <button className="primary-button" onClick={refreshApiRequestLog}>
          刷新 API 请求日志
        </button>
        {apiRequestLogError && <p className="error-text">{apiRequestLogError}</p>}
        {apiLogLines.length > 0 ? (
          <pre className="api-log-preview">{apiLogLines.join("\n")}</pre>
        ) : (
          <p className="muted">
            还没有 API 请求日志。截图进入分析队列并开始请求后，这里会出现记录。
          </p>
        )}
      </section>

      <section className="card wide">
        <div className="activity-log-head">
          <div>
            <p className="eyebrow">活动详情</p>
            <h2>本机活动日志</h2>
            <p className="muted">
              数据来自 {activityLogPath || "%LOCALAPPDATA%\\SuperGuider\\activity-log.md"}。
            </p>
            <p className="activity-range-status">
              当前范围：{rangeLabel} · 显示 {filteredRows.length} / {rows.length} 条
              {legacyRows > 0
                ? ` · ${legacyRows} 条旧日志缺少日期，已从时间过滤结果中隐藏`
                : ""}
            </p>
          </div>
          <div className="activity-time-controls">
            <label>
              起始
              <input
                type="datetime-local"
                value={detailsTimeRange.start}
                onChange={(event) =>
                  updateDetailsTimeRange({ start: event.currentTarget.value })
                }
              />
            </label>
            <label>
              结束
              <input
                type="datetime-local"
                value={detailsTimeRange.end}
                onChange={(event) =>
                  updateDetailsTimeRange({ end: event.currentTarget.value })
                }
              />
            </label>
            <button className="ghost-button" onClick={setDetailsRangeToday}>
              今天
            </button>
            <button className="primary-button" onClick={refreshActivityLog}>
              刷新日志
            </button>
          </div>
        </div>
        {activityLogError && <p className="error-text">{activityLogError}</p>}
        {filteredRows.length > 0 ? (
          <div className="activity-log-table-wrap">
            <table className="activity-log-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>应用</th>
                  <th>窗口</th>
                  <th>截图</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    className={[
                      row.appBreak ? "app-break" : "",
                      row.muted || isRowBlockedByAppPermission(row)
                        ? "muted-row"
                        : "",
                    ].filter(Boolean).join(" ") || undefined}
                    key={row.id}
                  >
                    <td>{row.time}</td>
                    <td>{row.app}</td>
                    <td>{row.windowTitle}</td>
                    <td>{renderScreenshotCell(row)}</td>
                    <td>{row.content}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            当前时间范围内没有活动日志。切换应用、完成一次采样，或调整右上角时间范围后再看。
          </p>
        )}
      </section>
    </div>
  );
}

function SettingsPage({
  settings,
  setSettings,
  apiKey,
  setApiKey,
  saveAiSettings,
  saveAppPermissions,
  aiSettingsSaveStatus,
  appPermissionsSaveStatus,
  databaseLoaded,
  resetDemoData,
  activityLogPath,
}: {
  settings: Settings;
  setSettings: (settings: Settings) => void;
  apiKey: string;
  setApiKey: (apiKey: string) => void;
  saveAiSettings: (nextSettings?: Settings) => Promise<void>;
  saveAppPermissions: (nextAppPermissions?: AppPermission[]) => Promise<void>;
  aiSettingsSaveStatus: AiSettingsSaveStatus;
  appPermissionsSaveStatus: AppPermissionsSaveStatus;
  databaseLoaded: boolean;
  resetDemoData: () => void;
  activityLogPath: string;
}) {
  const joinedApps = settings.appPermissions.filter(
    (permission) => permission.monitor_enabled && permission.user_confirmed,
  );
  const availableApps = settings.appPermissions.filter(
    (permission) => !permission.monitor_enabled || !permission.user_confirmed,
  );

  function updateAppPermission(
    permissionId: string,
    updates: Partial<AppPermission>,
  ) {
    const targetPermission = settings.appPermissions.find(
      (item) => item.id === permissionId,
    );
    const nextSettings = {
      ...settings,
      appPermissions: normalizeAppPermissions(
        settings.appPermissions.map((item) =>
          item.id === permissionId ||
          (targetPermission && areSameAppPermission(item, targetPermission))
            ? { ...item, ...updates }
            : item,
        ),
      ),
    };
    setSettings(nextSettings);
    void saveAppPermissions(nextSettings.appPermissions);
  }

  function renderAppPermission(
    permission: AppPermission,
    column: "joined" | "available",
  ) {
    return (
      <li
        className={
          permission.user_confirmed
            ? "app-permission-item"
            : "app-permission-item pending"
        }
        key={permission.id}
      >
        <div className="app-permission-main">
          <span className="app-permission-copy">
            <strong>{permission.app_name}</strong>
            <small>
              {permission.process_name || "快捷方式应用"} · {permission.discovery_source}
            </small>
          </span>
          {isWeChatApp(permission) && (
            <p className="wechat-hint">如果是工作微信，建议加入监控。</p>
          )}
        </div>
        <div className="app-permission-action">
          {!permission.user_confirmed ? (
            <>
              <p className="new-app-hint">检测到新应用，还未选择是否加入监控</p>
              <div className="app-permission-button-row">
                <button
                  className="ghost-button"
                  onClick={() =>
                    updateAppPermission(permission.id, {
                      monitor_enabled: true,
                      user_confirmed: true,
                    })
                  }
                >
                  加入
                </button>
                <button
                  className="ghost-button"
                  onClick={() =>
                    updateAppPermission(permission.id, {
                      monitor_enabled: false,
                      user_confirmed: true,
                    })
                  }
                >
                  拒绝
                </button>
              </div>
            </>
          ) : (
            <button
              className="ghost-button"
              onClick={() =>
                updateAppPermission(
                  permission.id,
                  column === "joined"
                    ? { monitor_enabled: false, user_confirmed: true }
                    : { monitor_enabled: true, user_confirmed: true },
                )
              }
            >
              {column === "joined" ? "移除监控范围" : "加入"}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="page-grid">
      <section className="card wide settings-block">
        <div className="settings-note app-permission-note">
          <strong>应用监控范围</strong>
          <p>
            首次启动会扫描桌面和任务栏固定的应用：除微信外默认加入监控，其他来源的应用默认不加入。
            微信默认不加入；如果是工作微信，建议加入监控。运行中发现的新应用会先加入待确认列表，确认前不会截图。这里的操作只保存应用监控范围，不会覆盖 API URL、API Key 或模型字段。
          </p>
        </div>
        <div className="app-permission-summary">
          <span>已发现 {settings.appPermissions.length} 个应用</span>
          <span>已加入 {joinedApps.length} 个</span>
          <span>未加入 {availableApps.length} 个</span>
          <span className={`save-status ${appPermissionsSaveStatus}`}>
            {appPermissionsSaveStatus === "saved"
              ? "应用监控已保存"
              : appPermissionsSaveStatus === "saving"
                ? "应用监控保存中..."
                : appPermissionsSaveStatus === "error"
                  ? "应用监控保存失败"
                  : "应用监控自动保存"}
          </span>
        </div>
        <div className="app-permission-columns">
          <section className="app-permission-column">
            <h3>已加入监控</h3>
            <ul className="app-permission-list">
              {joinedApps.length === 0 ? (
                <li className="app-permission-empty">还没有加入监控的应用。</li>
              ) : (
                joinedApps.map((permission) =>
                  renderAppPermission(permission, "joined"),
                )
              )}
            </ul>
          </section>
          <section className="app-permission-column">
            <h3>未加入监控</h3>
            <ul className="app-permission-list">
              {availableApps.length === 0 ? (
                <li className="app-permission-empty">
                  暂无未加入应用。运行中发现的新应用会出现在这里。
                </li>
              ) : (
                availableApps.map((permission) =>
                  renderAppPermission(permission, "available"),
                )
              )}
            </ul>
          </section>
        </div>
      </section>

      <section className="card wide settings-block">
        <div className="settings-note">
          <strong>API 与模型配置</strong>
          <p>
            真实 AI 使用 OpenAI 兼容的 chat completions 接口。只有 API URL、API Key、截图理解模型和任务导航模型都填写后，截图分析和任务分析才会请求真实 AI。这一块的保存按钮只保存这些私密接口字段。
          </p>
        </div>
        <label>
          API URL
          <input
            value={settings.apiUrl}
            onChange={(event) =>
              setSettings({ ...settings, apiUrl: event.currentTarget.value })
            }
            placeholder="https://api.example.com/v1"
          />
          <span className="field-note">
            填 OpenAI 兼容接口根路径或完整 /chat/completions，不要填控制台网页或普通网站首页；如果填根路径会自动拼接 /chat/completions。
          </span>
        </label>
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="sk-..."
          />
          <span className="field-note">保存到本机私密 settings 文件，不上传 GitHub。</span>
        </label>
        <label>
          截图理解模型
          <input
            value={settings.screenshotModel}
            onChange={(event) =>
              setSettings({
                ...settings,
                screenshotModel: event.currentTarget.value,
              })
            }
            placeholder="例如：gpt-4.1-mini"
          />
          <span className="field-note">
            截图保存为本机 PNG 后，会用这个模型返回中文截图摘要和详细转文字，再交给任务导航模型分析。
          </span>
        </label>
        <label>
          任务导航模型
          <input
            value={settings.navigationModel}
            onChange={(event) =>
              setSettings({
                ...settings,
                navigationModel: event.currentTarget.value,
              })
            }
            placeholder="例如：gpt-4.1"
          />
          <span className="field-note">
            当前真实 AI 分析使用这个模型，返回结果会先经过结构校验。
          </span>
        </label>
        <div className="settings-actions">
          <button
            className="primary-button"
            disabled={!databaseLoaded || aiSettingsSaveStatus === "saving"}
            onClick={() => void saveAiSettings()}
          >
            {!databaseLoaded
              ? "正在读取本机配置..."
              : aiSettingsSaveStatus === "saving"
                ? "保存中..."
                : "保存 API 与模型配置"}
          </button>
          <span className={`save-status ${aiSettingsSaveStatus}`}>
            {!databaseLoaded
              ? "本机配置读取完成后才能保存"
              : aiSettingsSaveStatus === "saved"
              ? "API 与模型配置已保存"
              : aiSettingsSaveStatus === "error"
                ? "保存失败，请看日志"
                : "修改后请点击保存"}
          </span>
        </div>
      </section>

      <section className="card wide settings-block">
        <div className="settings-note">
          <strong>本机数据与截图</strong>
          <p>
            任务、采样记录和分析结果保存到 SQLite：%LOCALAPPDATA%\SuperGuider\superguider.sqlite3。
            隐私配置保存到 %LOCALAPPDATA%\SuperGuider\private-settings.json。截图保存到 %LOCALAPPDATA%\SuperGuider\screenshots。
            可直接查看的活动日志保存到 {activityLogPath || "%LOCALAPPDATA%\\SuperGuider\\activity-log.md"}。
          </p>
        </div>
        <button className="danger-button" onClick={resetDemoData}>
          清空本机数据
        </button>
      </section>
    </div>
  );
}

function NotificationOrb({
  notification,
  onHoverChange,
  onCorrection,
}: {
  notification: NotificationScenario;
  onHoverChange: (hovering: boolean) => void;
  onCorrection: () => void;
}) {
  const correctionLabel =
    notification.button === "actually_related"
      ? "这其实相关"
      : notification.button === "important_detail"
        ? "这其实很重要"
        : "";

  return (
    <div
      className="orb-wrap"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div className="orb" />
      <div className="bubble">
        <span>{notification.notify_type}</span>
        <p>{notification.body}</p>
        {correctionLabel && (
          <button className="correction-button" onClick={onCorrection}>
            {correctionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export default App;

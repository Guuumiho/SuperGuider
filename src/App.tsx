import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  analysisResultSchema,
  type AnalysisResult,
  type NotifyButton,
  validateAnalysisResult,
} from "./aiContract";
import "./App.css";

type Page = "status" | "settings";
type AppMode = "silent_companion" | "task_tracking";

type Task = {
  goal: string;
  deadline: string;
  notes: string;
};

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

type GlobalInputEvent = {
  event_type: InputEventRecord["eventType"];
  source: InputEventRecord["source"];
};

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

type PrivateSettings = {
  api_url: string;
  api_key: string;
  screenshot_model: string;
  navigation_model: string;
  app_permissions?: AppPermission[];
};

type SettingsSaveStatus = "idle" | "saving" | "saved" | "error";

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
  contextSamples: ContextSampleRecord[];
  analysisResults: AnalysisResult[];
  summary: TaskSummary | null;
};

type ForegroundWindowSnapshot = {
  app_name: string;
  process_name: string;
  window_title: string;
  source: string;
};

type ScreenshotCaptureResult = {
  status: string;
  reason: string;
  source: string;
  width: number;
  height: number;
};

type ContextSampleRecord = {
  recordedAt: string;
  trigger: "manual_button" | InputEventRecord["source"];
  taskGoal: string;
  window: ForegroundWindowSnapshot | null;
  screenshot: ScreenshotCaptureResult | null;
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
  contextSamples: [],
  analysisResults: [],
  summary: null,
};

function appPermissionId(app: Pick<AppPermission, "app_name" | "process_name">) {
  const processName = app.process_name.trim().toLowerCase();
  if (processName) {
    return `process:${processName}`;
  }

  return `app:${app.app_name.trim().toLowerCase()}`;
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
  const merged = [...currentPermissions];
  const seen = new Set(merged.map((permission) => permission.id));

  for (const detectedApp of detectedApps) {
    const permission = createAppPermission(detectedApp, true);
    if (!seen.has(permission.id)) {
      merged.push(permission);
      seen.add(permission.id);
    }
  }

  return sortAppPermissions(merged);
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
  return new Set(
    [
      app.app_name,
      app.process_name,
      app.process_name.replace(/\.exe$/i, ""),
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
  return new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
      basis: `${appName} / ${windowTitle} / screenshot:${screenshotStatus}`,
      button: "actually_related",
    });
  }

  return validateAnalysisResult({
    recordedAt: nowLabel(),
    scenario: "context_sample_checked",
    should_notify: false,
    notify_type: "none",
    body: "已完成一次上下文采样。本地分析层暂不主动提示，只记录判断依据。",
    basis: `${appName} / ${windowTitle} / screenshot:${screenshotStatus}`,
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
  return {
    task: state.task ?? null,
    notificationRecords: state.notificationRecords ?? [],
    inputEventRecords: state.inputEventRecords ?? [],
    contextSamples: state.contextSamples ?? [],
    analysisResults: state.analysisResults ?? [],
    summary: state.summary ?? null,
  };
}

function App() {
  const storedState = loadStoredState();
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
  const [settingsSaveStatus, setSettingsSaveStatus] =
    useState<SettingsSaveStatus>("idle");
  const [activeNotification, setActiveNotification] =
    useState<NotificationScenario | null>(null);
  const [notificationRecords, setNotificationRecords] = useState<
    NotificationRecord[]
  >(storedState.notificationRecords);
  const [inputEventRecords, setInputEventRecords] = useState<InputEventRecord[]>(
    storedState.inputEventRecords,
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
  const [hoveringNotification, setHoveringNotification] = useState(false);
  const [databaseLoaded, setDatabaseLoaded] = useState(false);

  const initialized =
    settings.apiUrl &&
    apiKey &&
    settings.screenshotModel &&
    settings.navigationModel;

  useEffect(() => {
    let cancelled = false;

    async function loadStoredData() {
      try {
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
          const appPermissions = mergeAppPermissions(
            privateSettings.app_permissions ?? [],
            detectedApps,
          );
          setSettings({
            apiUrl: privateSettings.api_url,
            screenshotModel: privateSettings.screenshot_model,
            navigationModel: privateSettings.navigation_model,
            appPermissions,
          });
          setApiKey(privateSettings.api_key);
        } else {
          setSettings({
            ...defaultSettings,
            appPermissions: mergeAppPermissions([], detectedApps),
          });
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
    const stateToStore: StoredAppState = {
      task,
      notificationRecords,
      inputEventRecords,
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
    contextSamples,
    analysisResults,
    summary,
  ]);

  useEffect(() => {
    let disposed = false;
    let unlistenGlobalInput: (() => void) | null = null;

    listen<GlobalInputEvent>("superguider://global-input", (event) => {
      if (disposed) {
        return;
      }

      recordInputEvent(event.payload.event_type, event.payload.source);
      if (event.payload.event_type === "screenshot") {
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
    };
  }, [apiKey, settings, task]);

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

    setTask(draftTask);
    setMode("task_tracking");
    setSummary(null);
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
    setTask(state.task);
    setMode(state.task ? "task_tracking" : "silent_companion");
    setNotificationRecords(state.notificationRecords);
    setInputEventRecords(state.inputEventRecords);
    setContextSamples(state.contextSamples);
    setAnalysisResults(state.analysisResults);
    setSummary(state.summary);
    setActiveNotification(null);
  }

  function updateSettings(nextSettings: Settings) {
    setSettings(nextSettings);
    setSettingsSaveStatus("idle");
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    setSettingsSaveStatus("idle");
  }

  async function savePrivateSettings() {
    setSettingsSaveStatus("saving");

    const privateSettings: PrivateSettings = {
      api_url: settings.apiUrl,
      api_key: apiKey,
      screenshot_model: settings.screenshotModel,
      navigation_model: settings.navigationModel,
      app_permissions: settings.appPermissions,
    };

    try {
      await invoke("save_private_settings", { settings: privateSettings });
      setSettingsSaveStatus("saved");
    } catch (error) {
      console.warn("Could not save private settings", error);
      setSettingsSaveStatus("error");
    }
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

  async function captureContextSample(
    trigger: ContextSampleRecord["trigger"] = "manual_button",
  ) {
    try {
      setWindowSnapshotError("");
      setScreenshotError("");
      const snapshot = await invoke<ForegroundWindowSnapshot>(
        "get_foreground_window_snapshot",
      );

      setWindowSnapshot(snapshot);
      if (!canSampleApp(snapshot, settings.appPermissions)) {
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
          recordedAt: nowLabel(),
          trigger,
          taskGoal: task?.goal ?? "未开始任务",
          window: snapshot,
          screenshot: null,
          error: `已跳过截图：${blockReason}`,
        };

        if (!existingPermission) {
          setSettings((currentSettings) => {
            const alreadyExists = currentSettings.appPermissions.some(
              (permission) => permission.id === runtimePermission.id,
            );

            if (alreadyExists) {
              return currentSettings;
            }

            setSettingsSaveStatus("idle");
            return {
              ...currentSettings,
              appPermissions: sortAppPermissions([
                ...currentSettings.appPermissions,
                runtimePermission,
              ]),
            };
          });
        }

        setScreenshotResult(null);
        setContextSamples((records) => [
          sample,
          ...records,
        ]);
        setAnalysisResults((records) => [analyzeContextSample(sample), ...records]);
        return;
      }

      const screenshot = await invoke<ScreenshotCaptureResult>(
        "capture_screenshot_snapshot",
      );
      setScreenshotResult(screenshot);
      const sample: ContextSampleRecord = {
        recordedAt: nowLabel(),
        trigger,
        taskGoal: task?.goal ?? "未开始任务",
        window: snapshot,
        screenshot,
      };
      setContextSamples((records) => [
        sample,
        ...records,
      ]);
      const analysis = await analyzeSample(sample);
      setAnalysisResults((records) => [analysis, ...records]);
      triggerScenario(notificationFromAnalysis(analysis));
    } catch (error) {
      const message = String(error);
      setScreenshotError(message);
      const sample: ContextSampleRecord = {
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
      setAnalysisResults((records) => [analyzeContextSample(sample), ...records]);
    }
  }

  async function analyzeSample(sample: ContextSampleRecord) {
    if (
      !settings.apiUrl.trim() ||
      !apiKey.trim() ||
      !settings.navigationModel.trim()
    ) {
      return analyzeContextSample(sample);
    }

    try {
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
    } catch (error) {
      console.warn("Falling back to local analysis", error);
      return analyzeContextSample(sample);
    }
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
        ) : (
          <SettingsPage
            settings={settings}
            setSettings={updateSettings}
            apiKey={apiKey}
            setApiKey={updateApiKey}
            savePrivateSettings={savePrivateSettings}
            settingsSaveStatus={settingsSaveStatus}
            resetDemoData={resetDemoData}
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
          当前优先使用 Windows 全局键盘监听，前端窗口监听保留为兜底。Ctrl+C 会触发一次内存截图。
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
          当前会同时读取前台窗口和内存截图结果，形成一条 AI 输入骨架；截图不保存为图片文件。
        </p>
        <button className="primary-button" onClick={captureContextSample}>
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
          </dl>
        )}
        {screenshotError && <p className="error-text">{screenshotError}</p>}
      </section>

      <section className="card wide">
        <p className="eyebrow">上下文采样记录</p>
        <h2>最近一次 AI 输入骨架</h2>
        {contextSamples.length === 0 ? (
          <p className="muted">
            还没有采样记录。点击“采样当前上下文”或按 Ctrl+C 试一次。
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
                  </span>
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

function SettingsPage({
  settings,
  setSettings,
  apiKey,
  setApiKey,
  savePrivateSettings,
  settingsSaveStatus,
  resetDemoData,
}: {
  settings: Settings;
  setSettings: (settings: Settings) => void;
  apiKey: string;
  setApiKey: (apiKey: string) => void;
  savePrivateSettings: () => Promise<void>;
  settingsSaveStatus: SettingsSaveStatus;
  resetDemoData: () => void;
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
    setSettings({
      ...settings,
      appPermissions: sortAppPermissions(
        settings.appPermissions.map((item) =>
          item.id === permissionId ? { ...item, ...updates } : item,
        ),
      ),
    });
  }

  function renderAppPermission(permission: AppPermission) {
    return (
      <li
        className={
          permission.user_confirmed
            ? "app-permission-item"
            : "app-permission-item pending"
        }
        key={permission.id}
      >
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={permission.monitor_enabled && permission.user_confirmed}
            onChange={(event) =>
              updateAppPermission(permission.id, {
                monitor_enabled: event.currentTarget.checked,
                user_confirmed: true,
              })
            }
          />
          <span>
            <strong>{permission.app_name}</strong>
            <small>
              {permission.process_name || "快捷方式应用"} · {permission.discovery_source}
            </small>
          </span>
        </label>
        {isWeChatApp(permission) && (
          <p className="wechat-hint">如果是工作微信，建议勾选监控。</p>
        )}
        {!permission.user_confirmed && (
          <button
            className="ghost-button"
            onClick={() =>
              updateAppPermission(permission.id, { user_confirmed: true })
            }
          >
            确认加入列表
          </button>
        )}
      </li>
    );
  }

  return (
    <div className="page-grid">
      <section className="card wide">
        <div className="settings-note">
          <strong>配置说明</strong>
          <p>
            真实 AI 使用 OpenAI 兼容的 chat completions 接口。只有 API URL、API Key
            和任务导航模型都填写后，采样才会请求真实 AI；否则使用本地兜底分析。
            这些隐私配置会保存到本机 %LOCALAPPDATA%\SuperGuider\private-settings.json，不进入 GitHub。
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
            会自动拼接 /chat/completions；如果你直接填完整路径也可以。
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
            预留字段：当前截图只生成内存采样元信息，还没有把图片发送给视觉模型。
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
        <div className="settings-note app-permission-note">
          <strong>应用监控范围</strong>
          <p>
            首次启动会扫描桌面和任务栏固定的应用：除微信外默认勾选监控，其他来源的应用默认不勾选。
            微信默认不勾选；如果是工作微信，建议勾选监控。运行中发现的新应用会先加入待确认列表，确认前不会截图。
          </p>
        </div>
        <div className="app-permission-summary">
          <span>已发现 {settings.appPermissions.length} 个应用</span>
          <span>已加入 {joinedApps.length} 个</span>
          <span>未加入 {availableApps.length} 个</span>
        </div>
        <div className="app-permission-columns">
          <section className="app-permission-column">
            <h3>已加入监控</h3>
            <ul className="app-permission-list">
              {joinedApps.length === 0 ? (
                <li className="app-permission-empty">还没有加入监控的应用。</li>
              ) : (
                joinedApps.map(renderAppPermission)
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
                availableApps.map(renderAppPermission)
              )}
            </ul>
          </section>
        </div>
        <div className="settings-note">
          <strong>本机数据与截图</strong>
          <p>
            任务、采样记录和分析结果保存到 SQLite：%LOCALAPPDATA%\SuperGuider\superguider.sqlite3。
            隐私配置保存到 %LOCALAPPDATA%\SuperGuider\private-settings.json。截图不保存为图片文件，所以当前没有截图保存路径。
          </p>
        </div>
        <div className="settings-actions">
          <button
            className="primary-button"
            disabled={settingsSaveStatus === "saving"}
            onClick={() => void savePrivateSettings()}
          >
            {settingsSaveStatus === "saving" ? "保存中..." : "保存设置"}
          </button>
          <span className={`save-status ${settingsSaveStatus}`}>
            {settingsSaveStatus === "saved"
              ? "已保存到 %LOCALAPPDATA%\\SuperGuider\\private-settings.json"
              : settingsSaveStatus === "error"
                ? "保存失败，请看日志"
                : "修改后请点击保存"}
          </span>
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

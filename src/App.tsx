import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Page = "status" | "settings";
type AppMode = "silent_companion" | "task_tracking";
type NotifyButton = "none" | "actually_related" | "important_detail";

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
  apiKey: string;
  screenshotModel: string;
  navigationModel: string;
};

type StoredAppState = {
  settings: Settings;
  task: Task | null;
  notificationRecords: NotificationRecord[];
  inputEventRecords: InputEventRecord[];
  contextSamples: ContextSampleRecord[];
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
  apiKey: "",
  screenshotModel: "",
  navigationModel: "",
};

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

const demoSummary: TaskSummary = {
  scenario: "task_completed_summary",
  should_notify: false,
  summary_text:
    "这次主要推进了 SuperGuider 最小 Demo 的桌面壳、基础事件记录和提示气泡闭环。",
  time_breakdown: [
    { topic: "搭建 Tauri 主面板", duration_minutes: 55 },
    { topic: "调试窗口标题和输入事件", duration_minutes: 80 },
    { topic: "接入任务分析提示气泡", duration_minutes: 45 },
  ],
  final_observation:
    "后半段有一些视觉细节优化倾向，不过主线已经接近一个可演示闭环。",
};

function nowLabel() {
  return new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function loadStoredState(): StoredAppState {
  if (typeof window === "undefined") {
    return {
      settings: defaultSettings,
      task: null,
      notificationRecords: [],
      inputEventRecords: [],
      contextSamples: [],
      summary: null,
    };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {
        settings: defaultSettings,
        task: null,
        notificationRecords: [],
        inputEventRecords: [],
        contextSamples: [],
        summary: null,
      };
    }

    const parsed = JSON.parse(raw) as Partial<StoredAppState>;
    return {
      settings: { ...defaultSettings, ...parsed.settings },
      task: parsed.task ?? null,
      notificationRecords: parsed.notificationRecords ?? [],
      inputEventRecords: parsed.inputEventRecords ?? [],
      contextSamples: parsed.contextSamples ?? [],
      summary: parsed.summary ?? null,
    };
  } catch {
    return {
      settings: defaultSettings,
      task: null,
      notificationRecords: [],
      inputEventRecords: [],
      contextSamples: [],
      summary: null,
    };
  }
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
  const [settings, setSettings] = useState<Settings>(storedState.settings);
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

  const initialized =
    settings.apiUrl &&
    settings.apiKey &&
    settings.screenshotModel &&
    settings.navigationModel;

  useEffect(() => {
    const stateToStore: StoredAppState = {
      settings,
      task,
      notificationRecords,
      inputEventRecords,
      contextSamples,
      summary,
    };
    window.localStorage.setItem(storageKey, JSON.stringify(stateToStore));
  }, [
    settings,
    task,
    notificationRecords,
    inputEventRecords,
    contextSamples,
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
  }, [task]);

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
    setSummary(demoSummary);
    setActiveNotification(null);
  }

  function resetDemoData() {
    const confirmed = window.confirm("确定清空本机演示数据吗？");
    if (!confirmed) {
      return;
    }

    window.localStorage.removeItem(storageKey);
    setMode("silent_companion");
    setTask(null);
    setDraftTask({ goal: "", deadline: "", notes: "" });
    setSettings(defaultSettings);
    setActiveNotification(null);
    setNotificationRecords([]);
    setInputEventRecords([]);
    setContextSamples([]);
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
      const [snapshot, screenshot] = await Promise.all([
        invoke<ForegroundWindowSnapshot>("get_foreground_window_snapshot"),
        invoke<ScreenshotCaptureResult>("capture_screenshot_snapshot"),
      ]);

      setWindowSnapshot(snapshot);
      setScreenshotResult(screenshot);
      setContextSamples((records) => [
        {
          recordedAt: nowLabel(),
          trigger,
          taskGoal: task?.goal ?? "未开始任务",
          window: snapshot,
          screenshot,
        },
        ...records,
      ]);
    } catch (error) {
      const message = String(error);
      setScreenshotError(message);
      setContextSamples((records) => [
        {
          recordedAt: nowLabel(),
          trigger,
          taskGoal: task?.goal ?? "未开始任务",
          window: null,
          screenshot: null,
          error: message,
        },
        ...records,
      ]);
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
            initialized={Boolean(initialized)}
            settings={settings}
            setSettings={setSettings}
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
  initialized,
  settings,
  setSettings,
  resetDemoData,
}: {
  initialized: boolean;
  settings: Settings;
  setSettings: (settings: Settings) => void;
  resetDemoData: () => void;
}) {
  return (
    <div className="page-grid">
      <section className="hero-card">
        <p className="eyebrow">初始化设置</p>
        <h1>{initialized ? "已具备运行条件" : "还缺少模型配置"}</h1>
        <p>
          第一版暂时不会调用真实 AI，但保留这些入口，方便后续把内置场景
          替换成真实模型。
        </p>
      </section>

      <section className="card">
        <label>
          API URL
          <input
            value={settings.apiUrl}
            onChange={(event) =>
              setSettings({ ...settings, apiUrl: event.currentTarget.value })
            }
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) =>
              setSettings({ ...settings, apiKey: event.currentTarget.value })
            }
            placeholder="sk-..."
          />
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
        </label>
        <button className="danger-button" onClick={resetDemoData}>
          清空本机演示数据
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

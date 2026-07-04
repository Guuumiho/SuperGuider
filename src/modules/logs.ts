import type { AnalysisResult } from "../aiContract";

export type ActivityLogTableRow = {
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

export type ForegroundWindowSnapshotLike = {
  app_name: string;
  process_name: string;
  window_title: string;
  folder_path?: string | null;
  source: string;
};

export type ScreenshotCaptureResultLike = {
  status: string;
  reason: string;
  source: string;
  width: number;
  height: number;
  file_path: string | null;
  file_name: string | null;
};

export type ActivityAnalysisSummary = (analysis: AnalysisResult) => string;


export function activityLogTimeToTimestamp(time: string) {
  if (!time.trim()) {
    return undefined;
  }

  const normalized = time.includes("-")
    ? time.trim()
    : `${new Date().toISOString().slice(0, 10)} ${time.trim()}`;
  const timestamp = new Date(normalized.replace(" ", "T")).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function parseActivityLogTable(content: string): ActivityLogTableRow[] {
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

export function splitActivitySwitchLine(line: string) {
  return line.split("，");
}

export function parseActivitySampleLine(line: string) {
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

export function parseActivityScreenshotText(text: string) {
  return text.replace(/^截图\s*/, "") || "";
}

export function parseActivityContentText(text: string) {
  return text.replace(/^(分析|内容)\s*/, "") || "";
}

export function inferActivityTimeFromScreenshotName(screenshot: string) {
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

export function inferActivityTargetFromScreenshotName(screenshot: string) {
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

export function mergeActivityContent(current: string, next: string) {
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

export function isAppPermissionBlockStatus(status?: string) {
  return isAppPermissionBlockText(status ?? "");
}

export function isAppPermissionBlockText(text: string) {
  return [
    "已在设置中关闭监控",
    "尚未在设置中确认允许监控",
    "是新发现应用",
    "已跳过截图",
  ].some((keyword) => text.includes(keyword));
}

export function displayActivityTarget(rawApp: string, rawWindow: string) {
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

export function normalizeWindowTitle(value: string) {
  const title = value.trim();
  return title === "无具体窗口" || title === "Untitled window" ? "" : title;
}

export function isExplorerSystemWindowTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return [
    "任务切换",
    "task switching",
    "program manager",
  ].includes(normalized);
}

export function isExplorerShellSurface(title: string) {
  return !title || isExplorerSystemWindowTitle(title);
}

export function isExplorerLogShellSurface(rawApp: string, rawWindow: string) {
  const appKey = rawApp.trim().toLowerCase();
  return (
    (appKey === "explorer" || appKey === "explorer.exe") &&
    isExplorerShellSurface(normalizeWindowTitle(rawWindow))
  );
}

export function isShellOnlyForegroundSnapshot(snapshot: ForegroundWindowSnapshotLike) {
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

export function isTerminalApp(appKey: string) {
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

export function isBrowserApp(appKey: string) {
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

export function browserDisplayName(appKey: string) {
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

export function normalizeBrowserWindowTitle(title: string, appKey: string) {
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

export function compactActivityTitle(value: string, maxLength = 120) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}...`;
}


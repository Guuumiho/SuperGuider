import type { NotifyButton, NotificationDecision } from "../aiContract";

export type Settings = {
  apiUrl: string;
  screenshotModel: string;
  navigationModel: string;
  appPermissions: AppPermission[];
};

export type DetectedApp = {
  app_name: string;
  process_name: string;
  source: string;
};

export type AppPermission = {
  id: string;
  app_name: string;
  process_name: string;
  monitor_enabled: boolean;
  user_confirmed: boolean;
  discovery_source: string;
  discovered_at: string;
};

export type PermissionSnapshot = {
  app_name: string;
  process_name: string;
  window_title?: string;
  source: string;
};

function nowLabel() {
  return new Date().toLocaleString("sv-SE", { hour12: false });
}

export function appPermissionId(app: Pick<AppPermission, "app_name" | "process_name">) {
  const processName = app.process_name.trim().toLowerCase();
  if (processName) {
    return `process:${processName}`;
  }

  return `app:${app.app_name.trim().toLowerCase()}`;
}

export function normalizeAppPermissionRecord(permission: AppPermission): AppPermission {
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

export function createAppPermission(
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

export function mergeAppPermissions(
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

export function mergePermissionIntoList(
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

export function areSameAppPermission(left: AppPermission, right: AppPermission) {
  if (left.id === right.id) {
    return true;
  }

  const leftAliases = appNameAliases(left);
  const rightAliases = appNameAliases(right);
  return [...leftAliases].some((alias) => rightAliases.has(alias));
}

export function mergeDiscoverySource(left: string, right: string) {
  const sources = new Set([...left.split("+"), ...right.split("+")].filter(Boolean));
  return [...sources].join("+");
}

export function permissionFromSnapshot(snapshot: PermissionSnapshot) {
  return createAppPermission(
    {
      app_name: snapshot.app_name,
      process_name: snapshot.process_name,
      source: "foreground_window_runtime",
    },
    false,
  );
}

export function sortAppPermissions(permissions: AppPermission[]) {
  return [...permissions].sort((left, right) =>
    Number(right.monitor_enabled) - Number(left.monitor_enabled) ||
    Number(left.user_confirmed) - Number(right.user_confirmed) ||
    left.app_name.toLowerCase().localeCompare(right.app_name.toLowerCase()),
  );
}

export function normalizeAppPermissions(permissions: AppPermission[]) {
  const merged: AppPermission[] = [];
  for (const permission of permissions) {
    mergePermissionIntoList(merged, permission);
  }

  return sortAppPermissions(merged);
}

export function aiSettingsFingerprint(settings: Settings, apiKey: string) {
  return JSON.stringify({
    apiUrl: settings.apiUrl,
    apiKey,
    screenshotModel: settings.screenshotModel,
    navigationModel: settings.navigationModel,
  });
}

export function appPermissionsFingerprint(appPermissions: AppPermission[]) {
  return JSON.stringify({
    appPermissions: normalizeAppPermissions(appPermissions),
  });
}

export function shouldEnableMonitoringByDefault(app: DetectedApp) {
  if (isWeChatApp(app)) {
    return false;
  }

  return [
    "public_desktop",
    "user_desktop",
    "taskbar_pinned",
  ].includes(app.source);
}

export function appNameAliases(app: Pick<AppPermission, "app_name" | "process_name">) {
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

export function isWeChatApp(app: Pick<AppPermission, "app_name" | "process_name">) {
  const value = `${app.app_name} ${app.process_name}`.toLowerCase();
  return value.includes("wechat") || value.includes("weixin") || value.includes("微信");
}

export function canSampleApp(snapshot: PermissionSnapshot, permissions: AppPermission[]) {
  const permission = findAppPermission(snapshot, permissions);
  return Boolean(permission?.monitor_enabled && permission.user_confirmed);
}

export function findAppPermission(
  snapshot: PermissionSnapshot,
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

export type NotificationScenarioMap = Record<string, NotificationDecision & { button: NotifyButton }>;

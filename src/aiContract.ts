export type NotifyButton = "none" | "actually_related" | "important_detail";

export type AnalysisResult = {
  recordedAt: string;
  scenario: string;
  should_notify: boolean;
  notify_type: string;
  body: string;
  basis: string;
  button: NotifyButton;
};

export const analysisResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordedAt",
    "scenario",
    "should_notify",
    "notify_type",
    "body",
    "basis",
    "button",
  ],
  properties: {
    recordedAt: { type: "string", minLength: 1 },
    scenario: { type: "string", minLength: 1 },
    should_notify: { type: "boolean" },
    notify_type: { type: "string", minLength: 1 },
    body: { type: "string" },
    basis: { type: "string" },
    button: {
      type: "string",
      enum: ["none", "actually_related", "important_detail"],
    },
  },
} as const;

export function validateAnalysisResult(value: unknown): AnalysisResult {
  if (!isRecord(value)) {
    throw new Error("Analysis result must be an object.");
  }

  const allowedKeys = new Set(Object.keys(analysisResultSchema.properties));
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected analysis result field: ${key}`);
    }
  }

  const result = {
    recordedAt: requireString(value, "recordedAt"),
    scenario: requireString(value, "scenario"),
    should_notify: requireBoolean(value, "should_notify"),
    notify_type: requireString(value, "notify_type"),
    body: requireString(value, "body"),
    basis: requireString(value, "basis"),
    button: requireButton(value, "button"),
  };

  if (!result.recordedAt.trim()) {
    throw new Error("recordedAt cannot be empty.");
  }

  if (!result.scenario.trim()) {
    throw new Error("scenario cannot be empty.");
  }

  if (!result.notify_type.trim()) {
    throw new Error("notify_type cannot be empty.");
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  key: keyof AnalysisResult,
) {
  if (typeof value[key] !== "string") {
    throw new Error(`${key} must be a string.`);
  }

  return value[key];
}

function requireBoolean(
  value: Record<string, unknown>,
  key: keyof AnalysisResult,
) {
  if (typeof value[key] !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }

  return value[key];
}

function requireButton(
  value: Record<string, unknown>,
  key: keyof AnalysisResult,
): NotifyButton {
  const button = value[key];
  if (
    button !== "none" &&
    button !== "actually_related" &&
    button !== "important_detail"
  ) {
    throw new Error(`${key} must be a known notification button.`);
  }

  return button;
}

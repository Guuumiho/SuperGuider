
export type NotifyButton = "none" | "actually_related" | "important_detail";

export type TaskMode = "task_tracking" | "silent_companion";

export type TaskScope = "explicit_main_task" | "implicit_side_tasks";

export type AssignmentDecision = "existing" | "new" | "uncertain";

export type NotificationScenario =
  | "stuck_notification"
  | "off_track_notification"
  | "over_optimizing_notification"
  | "do_not_prompt_this_time";

export type NotifyType = "none" | "stuck" | "off_track" | "over_optimizing";

export type TaskAssignment = {
  decision: AssignmentDecision;
  task_id: string;
  task_label: string;
  task_scope: TaskScope;
  relation_to_main_task: "direct" | "supporting" | "unrelated" | "unknown";
  confidence: number;
  evidence: string;
};

export type StepAssignment = {
  decision: AssignmentDecision;
  step_id: string;
  step_label: string;
  step_summary: string;
  status: "not_started" | "in_progress" | "blocked" | "done" | "unknown";
  confidence: number;
  evidence: string;
};

export type MemoryUpdate = {
  action:
    | "append_to_existing_step"
    | "create_new_task"
    | "create_new_step"
    | "uncertain_no_update";
  new_facts: string[];
  reason: string;
};

export type NotificationDecision = {
  should_notify: boolean;
  scenario: NotificationScenario;
  notify_type: NotifyType;
  body: string;
  button: NotifyButton;
  reason: string;
};

export type TaskAnalysisItemResult = {
  task_assignment: TaskAssignment;
  step_assignment: StepAssignment;
  memory_update: MemoryUpdate;
  basis: string;
};

export type AnalysisResult = {
  recordedAt: string;
  mode: TaskMode;
  batch_summary: string;
  results: TaskAnalysisItemResult[];
  notification: NotificationDecision;
  basis: string;
};

const assignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "task_id",
    "task_label",
    "task_scope",
    "relation_to_main_task",
    "confidence",
    "evidence",
  ],
  properties: {
    decision: { type: "string", enum: ["existing", "new", "uncertain"] },
    task_id: { type: "string", minLength: 1 },
    task_label: { type: "string", minLength: 1 },
    task_scope: {
      type: "string",
      enum: ["explicit_main_task", "implicit_side_tasks"],
    },
    relation_to_main_task: {
      type: "string",
      enum: ["direct", "supporting", "unrelated", "unknown"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "string" },
  },
} as const;

const stepSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "step_id",
    "step_label",
    "step_summary",
    "status",
    "confidence",
    "evidence",
  ],
  properties: {
    decision: { type: "string", enum: ["existing", "new", "uncertain"] },
    step_id: { type: "string", minLength: 1 },
    step_label: { type: "string", minLength: 1 },
    step_summary: { type: "string" },
    status: {
      type: "string",
      enum: ["not_started", "in_progress", "blocked", "done", "unknown"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "string" },
  },
} as const;

const memoryUpdateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "new_facts", "reason"],
  properties: {
    action: {
      type: "string",
      enum: [
        "append_to_existing_step",
        "create_new_task",
        "create_new_step",
        "uncertain_no_update",
      ],
    },
    new_facts: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
} as const;

export const analysisResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "recordedAt",
    "mode",
    "batch_summary",
    "results",
    "notification",
    "basis",
  ],
  properties: {
    recordedAt: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["task_tracking", "silent_companion"] },
    batch_summary: { type: "string" },
    results: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "task_assignment",
          "step_assignment",
          "memory_update",
          "basis",
        ],
        properties: {
          task_assignment: assignmentSchema,
          step_assignment: stepSchema,
          memory_update: memoryUpdateSchema,
          basis: { type: "string" },
        },
      },
    },
    notification: {
      type: "object",
      additionalProperties: false,
      required: [
        "should_notify",
        "scenario",
        "notify_type",
        "body",
        "button",
        "reason",
      ],
      properties: {
        should_notify: { type: "boolean" },
        scenario: {
          type: "string",
          enum: [
            "stuck_notification",
            "off_track_notification",
            "over_optimizing_notification",
            "do_not_prompt_this_time",
          ],
        },
        notify_type: {
          type: "string",
          enum: ["none", "stuck", "off_track", "over_optimizing"],
        },
        body: { type: "string" },
        button: {
          type: "string",
          enum: ["none", "actually_related", "important_detail"],
        },
        reason: { type: "string" },
      },
    },
    basis: { type: "string" },
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

  const rawResults = value.results;
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    throw new Error("results must be a non-empty array.");
  }

  const results = rawResults.map(requireTaskAnalysisItemResult);
  const notification = requireNotification(value.notification);

  const result: AnalysisResult = {
    recordedAt: requireString(value, "recordedAt"),
    mode: requireMode(value.mode),
    batch_summary: requireOptionalString(value, "batch_summary"),
    results,
    notification,
    basis: requireString(value, "basis"),
  };

  if (!result.recordedAt.trim()) {
    throw new Error("recordedAt cannot be empty.");
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value;
}

function requireString(value: Record<string, unknown>, key: string) {
  if (typeof value[key] !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value[key];
}

function requireOptionalString(value: Record<string, unknown>, key: string) {
  if (value[key] === undefined) {
    return "";
  }
  return requireString(value, key);
}

function requireBoolean(value: Record<string, unknown>, key: string) {
  if (typeof value[key] !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }
  return value[key];
}

function requireNumber(value: Record<string, unknown>, key: string) {
  if (typeof value[key] !== "number" || Number.isNaN(value[key])) {
    throw new Error(`${key} must be a number.`);
  }
  return Math.max(0, Math.min(1, value[key]));
}

function requireStringArray(value: Record<string, unknown>, key: string) {
  const items = value[key];
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array.`);
  }
  return items;
}

function requireMode(value: unknown): TaskMode {
  if (value !== "task_tracking" && value !== "silent_companion") {
    throw new Error("mode must be task_tracking or silent_companion.");
  }
  return value;
}

function requireAssignmentDecision(value: unknown): AssignmentDecision {
  if (value !== "existing" && value !== "new" && value !== "uncertain") {
    throw new Error("decision must be existing, new, or uncertain.");
  }
  return value;
}

function requireTaskScope(value: unknown): TaskScope {
  if (value !== "explicit_main_task" && value !== "implicit_side_tasks") {
    throw new Error("task_scope must be explicit_main_task or implicit_side_tasks.");
  }
  return value;
}

function requireRelationToMainTask(
  value: unknown,
): TaskAssignment["relation_to_main_task"] {
  if (
    value !== "direct" &&
    value !== "supporting" &&
    value !== "unrelated" &&
    value !== "unknown"
  ) {
    throw new Error("relation_to_main_task must be a known relation.");
  }
  return value;
}

function requireStepStatus(value: unknown): StepAssignment["status"] {
  if (
    value !== "not_started" &&
    value !== "in_progress" &&
    value !== "blocked" &&
    value !== "done" &&
    value !== "unknown"
  ) {
    throw new Error("step status must be a known status.");
  }
  return value;
}

function requireMemoryAction(value: unknown): MemoryUpdate["action"] {
  if (
    value !== "append_to_existing_step" &&
    value !== "create_new_task" &&
    value !== "create_new_step" &&
    value !== "uncertain_no_update"
  ) {
    throw new Error("memory_update.action must be a known action.");
  }
  return value;
}

function requireNotifyType(value: unknown): NotifyType {
  if (
    value !== "none" &&
    value !== "stuck" &&
    value !== "off_track" &&
    value !== "over_optimizing"
  ) {
    throw new Error("notify_type must be a known notification type.");
  }
  return value;
}

function requireNotificationScenario(value: unknown): NotificationScenario {
  if (
    value !== "stuck_notification" &&
    value !== "off_track_notification" &&
    value !== "over_optimizing_notification" &&
    value !== "do_not_prompt_this_time"
  ) {
    throw new Error("notification.scenario must be a known scenario.");
  }
  return value;
}

function requireButton(value: unknown): NotifyButton {
  if (
    value !== "none" &&
    value !== "actually_related" &&
    value !== "important_detail"
  ) {
    throw new Error("button must be a known notification button.");
  }
  return value;
}

function requireTaskAssignment(value: unknown): TaskAssignment {
  const record = requireRecord(value, "task_assignment");
  return {
    decision: requireAssignmentDecision(record.decision),
    task_id: requireString(record, "task_id"),
    task_label: requireString(record, "task_label"),
    task_scope: requireTaskScope(record.task_scope),
    relation_to_main_task: requireRelationToMainTask(record.relation_to_main_task),
    confidence: requireNumber(record, "confidence"),
    evidence: requireOptionalString(record, "evidence"),
  };
}

function requireStepAssignment(value: unknown): StepAssignment {
  const record = requireRecord(value, "step_assignment");
  return {
    decision: requireAssignmentDecision(record.decision),
    step_id: requireString(record, "step_id"),
    step_label: requireString(record, "step_label"),
    step_summary: requireOptionalString(record, "step_summary"),
    status: requireStepStatus(record.status),
    confidence: requireNumber(record, "confidence"),
    evidence: requireOptionalString(record, "evidence"),
  };
}

function requireMemoryUpdate(value: unknown): MemoryUpdate {
  const record = requireRecord(value, "memory_update");
  return {
    action: requireMemoryAction(record.action),
    new_facts: requireStringArray(record, "new_facts"),
    reason: requireOptionalString(record, "reason"),
  };
}

function requireNotification(value: unknown): NotificationDecision {
  const record = requireRecord(value, "notification");
  return {
    should_notify: requireBoolean(record, "should_notify"),
    scenario: requireNotificationScenario(record.scenario),
    notify_type: requireNotifyType(record.notify_type),
    body: requireOptionalString(record, "body"),
    button: requireButton(record.button),
    reason: requireOptionalString(record, "reason"),
  };
}

function requireTaskAnalysisItemResult(value: unknown): TaskAnalysisItemResult {
  const record = requireRecord(value, "results[]");
  const taskAssignment = requireTaskAssignment(record.task_assignment);
  const stepAssignment = requireStepAssignment(record.step_assignment);
  if (!taskAssignment.task_label.trim()) {
    throw new Error("task_assignment.task_label cannot be empty.");
  }
  if (!stepAssignment.step_label.trim()) {
    throw new Error("step_assignment.step_label cannot be empty.");
  }
  return {
    task_assignment: taskAssignment,
    step_assignment: stepAssignment,
    memory_update: requireMemoryUpdate(record.memory_update),
    basis: requireOptionalString(record, "basis"),
  };
}

export type TestTaskAnalysisStatus = "queued" | "running" | "done" | "failed";

export type TestTaskAnalysisItem = {
  id: string;
  sampleIds: string[];
  recordedAt: string;
  endAt: string;
  screenshotFileName: string;
  appName: string;
  windowTitle: string;
  sampleCount: number;
  status: TestTaskAnalysisStatus;
  attempts: number;
  rawResponse?: string;
  parsedBody?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type TestTaskAnalysisRun = {
  id: string;
  name: string;
  start: string;
  end: string;
  createdAt: string;
  status: TestTaskAnalysisStatus;
  items: TestTaskAnalysisItem[];
};

export function updateTestTaskAnalysisItem(
  runs: TestTaskAnalysisRun[],
  runId: string,
  itemId: string,
  updates: Partial<TestTaskAnalysisItem>,
): TestTaskAnalysisRun[] {
  return runs.map((run) => {
    if (run.id !== runId) {
      return run;
    }

    const items = run.items.map((item) =>
      item.id === itemId ? { ...item, ...updates } : item,
    );
    const status: TestTaskAnalysisStatus = items.some((item) => item.status === "running")
      ? "running"
      : items.some((item) => item.status === "queued")
        ? "queued"
        : items.some((item) => item.status === "failed")
          ? "failed"
          : "done";

    return {
      ...run,
      status,
      items,
    };
  });
}

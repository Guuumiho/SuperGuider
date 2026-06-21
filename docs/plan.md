# SuperGuider MVP Plan

## Strategy

Use mock-first development:

```text
UI shell -> local state -> mock AI -> orb notification -> records -> Windows capability -> real AI -> schema
```

The purpose is to avoid debugging UI, Tauri, Windows APIs, screenshots, AI requests, and data validation all at once.

## Phase 0: Initialize Project

Goal:

- Generate Tauri + React + TypeScript project.
- Install dependencies.
- Verify frontend and Tauri commands compile.

Done when:

- `npm install` succeeds.
- `npm run build` succeeds.
- `cargo check` succeeds in `src-tauri`.

## Phase 1: App Panel

Goal:

- Replace starter UI with SuperGuider panel.
- Add Status and Settings navigation.
- Add silent companion empty state.

Done when:

- Status and Settings switch correctly.
- Silent companion state is visible.

## Phase 2: Task Creation

Goal:

- Add task creation form.
- Store active task in local UI state.
- Show task tracking state.

Done when:

- User can create a task.
- Status page shows task goal and deadline.

## Phase 3: Mock Plan

Goal:

- Load task plan mock.
- Display reference stages.

Done when:

- Task page shows stage title, goal, and estimated minutes.

## Phase 4: Mock Notifications

Goal:

- Add debug buttons for stuck, off-track, over-optimizing, and no-notify.
- Show orb bubble from mock data.

Done when:

- `should_notify = true` displays a bubble.
- `should_notify = false` stays quiet.
- Correction button maps correctly.

## Phase 5: Notification Records

Goal:

- Record shown, auto-dismissed, and correction-clicked states.

Done when:

- Recent notification record appears in the UI.

## Phase 6: Task End Summary

Goal:

- End active task.
- Show mock summary.
- Return to silent companion.

Done when:

- User can end task and see summary.

## Later

- Foreground window capture must include `app_name`, `process_name`, `window_title`, and optional `folder_path`.
- Explorer/folder windows should prefer `folder_path`; if the path is unavailable and the title is only a system title such as `任务切换`, show an empty window cell.
- Foreground-window deduplication should use the normalized display target, not the raw `window_title`, so `无具体窗口`, blank Explorer titles, and `任务切换` do not create repeated switch records.
- Activity detail rows should use the columns `时间 / 应用 / 窗口 / 截图 / 内容`.
- Activity-log parsing should skip switch rows that have no visible app, window, or content after normalization. Old log lines such as `explorer，` should not render as empty rows.
- Terminal titles/commands belong in `内容`, not `窗口`.
- Apps that are not allowed or not confirmed for monitoring should still have a time/app row, but screenshot and content cells stay empty and the row uses the same light gray as the time column.
- App permission persistence must be treated as a single source of truth in `%LOCALAPPDATA%\SuperGuider\private-settings.json`.
- Permission records should be normalized by stable process/app identity before saving. If duplicate records exist for the same app, a confirmed user decision (`user_confirmed=true`) wins over a runtime pending discovery.
- Runtime app discovery may update React state, but should not immediately write a separate pending permission record to disk. App-permission saves should be queued and guarded against stale writes so older pending snapshots cannot overwrite a newer `加入` or `拒绝` decision.
- Private settings writes are split by ownership. `save_app_permissions` updates only `app_permissions`; `save_ai_private_settings` updates only `api_url`, `api_key`, `screenshot_model`, and `navigation_model`. UI actions in one settings block must not overwrite fields owned by the other block.
- The settings UI puts `应用监控范围` first. `API 与模型配置` is a separate block with its own save button, disabled until local private settings have finished loading.
- Repeated fast app switching protection is a later iteration. Current behavior delays screenshot capture until the normalized foreground target is stable for 3 seconds; later work can add rolling-window suppression for very frequent switching.
- Ctrl+C / Enter listener. Both global keyboard events and frontend-window fallback events trigger the same context sampling path.
- Screenshot capture. Capture is entered from manual sampling, stable foreground switch, Enter/Ctrl+C, and the maximum three-minute fallback. A captured screenshot is logged before screenshot understanding is queued.
- Screenshot understanding queue. Screenshot analysis updates the original activity-log row; missing screenshot model/API configuration remains visible as a retry reason in the row. The screenshot model must return structured JSON with `summary` and `detailText`: `summary` is the short 2-5 sentence display summary, while `detailText` is the detailed transcription retained in the sample state and available to test-only task analysis.
- Queue-level retry. Screenshot analysis and task analysis each own a queue-level retry/cooldown state. API/config/model-response failures keep the just-failed item in place and retry it before any later item. Retry timing is immediate, then 1 minute, 2 minutes, 3 minutes, 5 minutes, 30 minutes, then 1 hour. This avoids treating an API endpoint problem as if it might be fixed by switching to a different screenshot.
- Queue retry reset. A successful request clears that queue's retry state so the next failure starts from the beginning of the retry sequence. During cooldown, the Details panel exposes `立即重发`, which cancels the current cooldown and retries the just-failed item without clearing the failure count unless the request succeeds.
- Formal task analysis is disabled for now. Screenshot analysis completion does not enqueue formal task analysis, and the formal task-analysis loop does not send model requests. The Details page provides a test-only task-analysis module: create a named run, choose a start/end range, enqueue screenshots from that range in chronological order, store results separately from production analysis state, select prior runs by name, and expand each item to inspect the full raw model response.
- Test build queue controls. The Details queue panel has pause/start controls for screenshot analysis. The legacy task-analysis queue remains visible as disabled/diagnostic state, but formal task analysis is not allowed to consume tokens. Pausing only stops sending new API requests from that queue; queued items, screenshots, logs, sampling, and queue-level retry state continue to exist. This is an in-memory testing control and is not persisted.
- API request logging. `api-request-log.md` is a model-call audit log, not only a status timeline. Each model call should append endpoint, model, status, content type, sanitized request JSON with full prompts, raw response body, and extracted message content. API keys are not logged; image data URLs are replaced with omitted-length markers.
- Activity log time range. The Details activity-log panel exposes start/end datetime controls and a `今天` shortcut. Silent companion defaults to today; task tracking defaults to the task's `startedAt` through deadline. New log lines use full local date-time. Legacy clock-only lines can be repaired by inferring dates from nearby screenshot filenames that contain `YYYYMMDD-HHMMSS`.
- Activity log shell filtering. Explorer shell-transition states such as blank titles, `Program Manager`, `任务切换`, `无具体窗口`, and `Untitled window` are filtered at the source and should not create switch rows or stable screenshots. Real Explorer folders/search results still render as `文件夹`.
- Rest period. The global input hook emits ordinary keyboard/mouse activity. If no input is seen for 5 minutes, write a `休息` row and pause automatic screenshot capture. New activity exits rest and immediately records the current foreground app so the timeline resumes from the actual work context.
- Alt+Tab source suppression. The Windows global keyboard hook emits Alt+Tab pulse/end events. The frontend suppresses foreground-window logging and stable screenshot scheduling while Alt+Tab is active, keeps suppressing for about 1.2 seconds after Alt is released, and uses a 2.5 second watchdog if keyup is missed.
- SQLite persistence.
- Real AI calls.
- JSON Schema validation.

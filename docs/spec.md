# SuperGuider MVP Spec

## Goal

Build the first runnable SuperGuider demo with a mock-first loop:

```text
Create task -> load mock plan -> trigger mock analysis -> show orb notification -> record result -> end task
```

This is not the full product MVP. It is the smallest development slice that proves the main experience can run.

## Confirmed Stack

- Desktop shell: Tauri 2
- UI: React + TypeScript
- System layer: Rust
- Development data: mock JSON files first
- Strict JSON Schema: later, after mocks and UI stabilize

## First Demo Scope

The first demo must support:

- Status page and settings page.
- Silent companion empty state.
- Create a task with description and deadline.
- Load a mock task plan.
- Show reference stages on the status page.
- Trigger mock analysis from debug buttons.
- Show a temporary lower-right orb and notification bubble when `should_notify = true`.
- Support correction buttons for off-track and over-optimizing prompts.
- Auto-dismiss notification after 10 seconds.
- Record notification and correction state locally.
- End the task and show a mock summary.

## Out Of Scope For First Demo

- Real AI calls.
- Strict JSON Schema.
- Full Windows hooks.
- Real screenshots.
- Full screenshot permission management.
- Complete silent companion intelligence.
- Complex pet animation.
- Full log dashboard.

## Minimal Mock Contract

The UI only needs these fields for the first notification loop:

```json
{
  "scenario": "stuck_notification",
  "should_notify": true,
  "notify_type": "stuck",
  "body": "You seem stuck. Try a smaller verification first.",
  "button": "none"
}
```

Allowed `button` values for the first demo:

- `none`
- `actually_related`
- `important_detail`

## Acceptance Criteria

- The desktop app launches.
- The user can switch between Status and Settings.
- The user can create a task.
- The task page shows mock plan stages.
- A mock stuck notification can be triggered and displayed.
- A mock off-track notification can show `这其实相关`.
- A mock over-optimizing notification can show `这其实很重要`.
- A no-notify mock does not show the bubble.
- Notification auto-dismiss is recorded.
- Correction clicks are recorded.
- The user can end the task and see a mock summary.

## Current Product Decisions

- The desktop companion uses a small lower-right glowing orb for the demo. A more expressive mascot can be revisited only if the core tracking loop is already stable.
- Task tracking is explicitly started by the user. Required input: task description and deadline.
- Screenshot and timing belong to one system: foreground app/sub-window time is tracked continuously; screenshots are triggered after a stable foreground switch, user key events, or the maximum interval fallback.
- A foreground switch should schedule a screenshot only after the normalized foreground target stays unchanged for 3 seconds. The user key events `Enter` and `Ctrl+C` should trigger immediate sampling through the same queue path. If no sampling attempt has happened for 3 minutes, the app should make one fallback sampling attempt.
- Every successful screenshot capture must first write a visible sample row to `activity-log.md`, then enqueue screenshot understanding. Screenshot understanding writes back to the same row. Formal task analysis is currently disabled to avoid token waste; test-only task analysis runs are created manually from the Details page. If model/API settings are missing, the same row should show the retry reason instead of silently disappearing.
- Screenshot understanding must return two data layers: `summary` is the current 2-5 sentence Chinese summary for quick UI display, and `detailText` is a detailed Chinese text transcription that preserves visible content, UI elements, layout, states, text, numbers, errors, and task clues for future structured extraction. Test task analysis should receive both layers through the stored sample; later code must not collapse screenshot understanding back into a single lossy string.
- After screenshot understanding succeeds, the activity detail content must show the screenshot summary itself, followed by the task-analysis pending state. It must not replace the model output with only `截图已分析，任务分析待分析`.
- Analysis retry is queue-level, not image-level. When screenshot analysis or task analysis fails because of API connectivity, API key, endpoint, or model response format, the same queue should retry the just-failed item first. The queue retries immediately once, then waits 1 minute, 2 minutes, 3 minutes, 5 minutes, 30 minutes, then 1 hour for later failures. During queue cooldown, later screenshots or task-analysis items must wait instead of bypassing the failed item.
- A successful retry clears that queue's retry sequence, so the next failure starts again from immediate retry, then 1 minute. During cooldown, the test control should offer `立即重发`; this clears only the current cooldown and sends the just-failed item again, while success is still what resets the failure count.
- Formal task analysis is disabled. Screenshot analysis must not automatically enqueue task analysis, and the old formal task-analysis processing loop must not send model requests. The Details page owns a test-only task-analysis module: the user names a run, selects a start/end time range, and the app sends screenshots from that range to the navigation model in chronological order. Test results are isolated in `testTaskAnalysisRuns`, can be selected by run name, and each item can reveal the full raw model response.
- API request logging must be useful for debugging real model calls. `%LOCALAPPDATA%\SuperGuider\api-request-log.md` must include each model call's endpoint, model, status, content type, sanitized request JSON including full prompts, raw response body, and extracted `choices[0].message.content`. API keys are never logged, and image base64 is replaced by an omitted-length marker.
- App screenshot permission is explicit. Apps not allowed or not confirmed must not visually occupy attention in the activity detail table: their screenshot and content cells stay empty, and the row is shown in the same light gray used by the time column.
- Once the user clicks `加入` or `拒绝` for an app, that decision must persist and must not reappear as `检测到新应用`. Runtime discovery may add new apps to the pending list, but it must never overwrite a confirmed user decision.
- Settings are separated into two user-facing blocks: `应用监控范围` at the top, then `API 与模型配置`. App-monitoring changes may auto-save only `app_permissions`; the API/model save button saves only `api_url`, `api_key`, `screenshot_model`, and `navigation_model`.
- API/model fields must be hydrated from `%LOCALAPPDATA%\SuperGuider\private-settings.json` before the user can save that block. A transient empty React state must never overwrite existing local API/model values.
- Explorer/folder activity should show the real folder path when it can be detected. If the folder path cannot be detected, the window cell stays empty. System titles such as `任务切换` must not be shown as a folder/window name.
- Explorer/folder empty states such as `无具体窗口`, blank titles, `Program Manager`, and `任务切换` are Windows shell-transition states, not user work context. They should be filtered at the source: no switch row, no stable screenshot, and no visible activity-detail row. Real Explorer folder/search-result windows should still show as `文件夹`.
- Terminal activity treats the command/title as content rather than a window. The `窗口` column stays empty for terminal rows, and the terminal title is shown in `内容`.
- The activity detail table uses `内容`, not `分析`, because the column can contain screenshot notes, task analysis, terminal command/title content, or other context. Historical logs that still say `分析` should remain readable.
- Activity detail should suppress rows that have no visible app, window, screenshot, or content after normalization. These rows are implementation noise, not user-facing progress.
- The activity detail table has a right-side time range filter with start/end datetime fields and a `今天` shortcut. In silent companion mode the default range is today. In task tracking mode the default range is the task span, from task start time to deadline. Activity-log rows should store full local date-time. Older clock-only rows can be repaired by inferring dates from nearby screenshot filenames when the filename contains a `YYYYMMDD-HHMMSS` timestamp.
- The global input hook emits ordinary keyboard/mouse activity events in addition to Enter, Ctrl+C, and Alt+Tab. User activity updates the active-time clock but ordinary activity events are not written to the visible input log.
- After 5 minutes without keyboard or mouse activity, the app enters a visible rest period by writing a `休息` activity row. During rest, automatic screenshots, stable foreground screenshots, and maximum-interval fallback sampling are paused. Existing analysis queues may continue. New keyboard/mouse activity exits rest, reads the current foreground window, and writes the current app so the timeline does not remain stuck on `休息`.
- Alt+Tab should be filtered at the source. The global keyboard hook emits Alt+Tab pulse/end events; while Alt+Tab is active and for about 1.2 seconds after it ends, foreground-window changes must not be written to activity-log.md and must not schedule stable screenshots. A watchdog should end suppression if keyup is missed.
- Future notification quality iteration: task analysis must avoid low-value, obvious, or annoying reminders. It should not notify the user about already-visible infrastructure failures such as missing API/model configuration unless the user explicitly opens diagnostics. Notification copy must provide concrete guidance, not generic filler. If the model raises a scenario that does not fit a predefined correction button, the UI should allow no button or a generic dismissal instead of forcing `actually_related` / `important_detail`.
- Repeated fast app switching is an iteration item for now, not part of the immediate implementation.

# SuperGuider MVP Tasks

## Milestone 1: Project Initialization

- [x] Scaffold Tauri + React + TypeScript project.
- [x] Install npm dependencies.
- [x] Run frontend build.
- [x] Run Rust cargo check.
- [x] Replace starter README with SuperGuider notes.

## Milestone 2: App Panel

- [x] Replace starter UI.
- [x] Add `Status` navigation item.
- [x] Add `Settings` navigation item.
- [x] Implement page switching.
- [x] Show silent companion empty state.

## Milestone 3: Settings Page

- [x] Add API URL field.
- [x] Add API Key field.
- [x] Add screenshot understanding model field.
- [x] Add task navigation model field.
- [x] Add initialization status.
- [x] Save settings in local state.

## Milestone 4: Task Creation

- [x] Add `开启任务追踪` button.
- [x] Add task creation form.
- [x] Validate task description.
- [x] Validate deadline.
- [x] Store active task.
- [x] Show task tracking status.

## Milestone 5: Mock Task Plan

- [x] Load built-in demo task plan data.
- [x] Display reference stages.
- [x] Display plan `body`.

## Milestone 6: Mock Analysis Buttons

- [x] Add stuck mock button.
- [x] Add off-track mock button.
- [x] Add over-optimizing mock button.
- [x] Add no-notify mock button.
- [x] Store latest mock result.

## Milestone 7: Orb Notification

- [x] Create orb component.
- [x] Create notification bubble component.
- [x] Read `should_notify`.
- [x] Read `body`.
- [x] Map `button` to correction UI.
- [x] Hide bubble for no-notify mock.

## Milestone 8: Notification Lifecycle

- [x] Auto-dismiss after 10 seconds.
- [x] Pause timer on hover.
- [x] Record auto-dismiss.
- [x] Record correction clicks.
- [x] Show latest notification record.

## Milestone 9: Task End

- [x] Add end task button.
- [x] Add confirmation.
- [x] Load built-in demo task summary data.
- [x] Show summary.
- [x] Return to silent companion.

## Milestone 10: Local Persistence

- [x] Persist settings in `localStorage`.
- [x] Persist active task in `localStorage`.
- [x] Persist notification records in `localStorage`.
- [x] Persist task summary in `localStorage`.
- [x] Add a reset demo data button.

## Later

- [x] Add Rust command placeholder for foreground window snapshot.
- [x] Show foreground window snapshot in Status page debug area.
- [x] Replace foreground window mock with real Windows API.
- [x] Add frontend-window Ctrl+C / Enter listener.
- [x] Record frontend-window input events in local state.
- [x] Replace frontend-window input listener with global Windows hook.
- [x] Route global Enter and Ctrl+C through the shared context sampling path.
- [x] Trigger context sampling after the normalized foreground target remains stable for 3 seconds.
- [x] Add a maximum three-minute fallback sampling attempt.
- [x] Add Rust screenshot capture command placeholder.
- [x] Show screenshot command result in Status page debug area.
- [x] Replace screenshot placeholder with real capture.
- [x] Enqueue screenshot understanding after capture and write retry reasons back to the activity log.
- [x] Make screenshot understanding return both a 2-5 sentence summary and a detailed text transcription for future extraction.
- [x] Add test-only pause/start controls for screenshot analysis and task analysis queues.
- [x] Move API failure retry from per-item due times to queue-level cooldown and resend the just-failed item first.
- [x] SQLite.
- [x] Real AI.
- [x] JSON Schema.
- [x] Show Explorer folder path when available.
- [x] Hide Explorer system titles such as `任务切换`.
- [x] Rename activity detail table `分析` column to `内容`.
- [x] Add activity-log start/end time range controls with a `今天` shortcut and mode-based defaults.
- [x] Filter Explorer shell-transition foreground states so blank desktop/task-switch noise does not become activity rows or screenshots.
- [x] Suppress foreground logging and stable screenshots during Alt+Tab switching windows.
- [x] Add global keyboard/mouse activity tracking and a 5-minute `休息` period that pauses automatic screenshots.
- [x] Disable formal task analysis to avoid token waste.
- [x] Add test-only task analysis runs with name selection, time range selection, isolated results, and expandable raw model responses.
- [x] Expand API request logging to include sanitized request prompts, raw responses, and extracted model message content.
- [x] Move terminal title/command display from `窗口` to `内容`.
- [ ] Improve task-analysis notification quality: avoid obvious API/config failure reminders, remove annoying filler copy, and do not force template-specific correction buttons for non-template scenarios.
- [x] De-emphasize not-allowed app rows and leave screenshot/content empty.
- [x] Persist confirmed app permission decisions without reverting them to new-app pending state.
- [x] Normalize duplicate app permission records and prefer confirmed user decisions.
- [x] Split private settings saves so app monitoring changes cannot overwrite API URL, API Key, or model fields.
- [x] Move app monitoring to the top of Settings and isolate API/model fields in their own saved block.
- [x] Disable API/model saving until local private settings have been loaded.
- [x] Filter normalized empty activity rows from the details table.
- [x] Deduplicate Explorer empty/system foreground states before writing switch records.
- [x] Document repeated fast app switching protection as an iteration item.
- [ ] Implement repeated fast app switching protection.
- [ ] Verify the test-only task-analysis module in the running app after the full API log change.
- [ ] Commit and push the rest-period/test-analysis/API-log iteration.

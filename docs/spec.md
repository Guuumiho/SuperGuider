# SuperGuider 当前规格说明

更新时间：2026-06-28

## 1. 当前目标

SuperGuider 是 Windows 桌面端低打扰 AI 任务引导助手。当前版本已经从 mock-first Demo 进入真实本机采样阶段：

```text
前台窗口/键鼠活动 -> 权限判断 -> 截图落盘 -> 截图理解 -> 活动日志回写 -> 测试任务分析按分钟批处理 -> 任务记忆增量更新
```

正式自动任务分析暂时关闭，避免持续消耗 token。任务分析目前通过详情页测试模块手动创建 run。

## 2. 技术栈

- 桌面壳：Tauri 2
- 前端：React + TypeScript + Vite
- 原生层：Rust
- 本机数据：SQLite、localStorage、`%LOCALAPPDATA%\SuperGuider`
- 模型接口：兼容 Chat Completions 的视觉模型和任务导航模型
- 核心文档索引：`docs/function-index.md`

## 3. 当前模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 设置模块 | `src/modules/settings.ts` | API/模型设置、应用权限合并、截图权限判断。 |
| 日志模块 | `src/modules/logs.ts` | 活动日志解析、展示归一化、Explorer/浏览器/终端处理。 |
| 测试模块 | `src/modules/testAnalysis.ts` | 测试任务分析 run/item 类型与状态更新。 |
| 分析契约 | `src/aiContract.ts` | 任务分析 schema、返回类型和运行时校验。 |
| 主编排/UI | `src/App.tsx` | 状态机、队列、页面、采样和用户交互。 |
| 原生能力 | `src-tauri/src/lib.rs` | 截图、前台窗口、全局输入、AI 请求、日志、SQLite。 |

## 4. 截图理解规格

截图理解模型必须返回 JSON：

```json
{
  "summary": "用户正在做什么或者看什么",
  "detailText": "详细转文字版",
  "hoverPoint": "鼠标悬停点"
}
```

要求：

- `summary`：简体中文，概括当前用户正在做什么；聊天窗要特别关注用户刚发出的信息。
- `detailText`：尽量完整保留可见内容、UI 元素、文字、数字、状态、错误、选中项和任务线索。
- `hoverPoint`：说明鼠标当前悬停在什么内容或元素上；不能识别时写“未能识别”。
- 活动日志悬浮层展示摘要、详细说明、鼠标悬停点。

## 5. 任务分析规格

任务分析是测试专用模块：

- 用户在详情页创建测试 run。
- 选择开始/结束时间和测试名称。
- 系统筛选该时间段内有截图分析结果的样本。
- 按一分钟分组，每分钟一个请求。
- 请求上下文包含 `productMode`、`taskRules`、`explicitMainTask`、`taskMemory`、`currentBatch`、`notificationTemplates`、`outputPolicy`。
- 静默陪伴下 `explicitMainTask = null`，样本写 `taskGoal = null`、`taskGoalSource = "none"`。
- 任务导航模式下明确任务写 `taskGoal = task.goal`、`taskGoalSource = "explicit_main_task"`。

任务分析返回 JSON 必须符合 `src/aiContract.ts` 的 `analysisResultSchema`：

- 顶层：`recordedAt`、`mode`、`batch_summary`、`results[]`、`notification`、`basis`。
- `results[]` 可返回多条任务/阶段归属和记忆更新。
- `notification` 是批次级提示，提示是可选的；任务归属和阶段归属是必做的。

## 6. 队列与重试

- 截图分析队列每 1 秒检查一次。
- 测试任务分析队列每 60 秒检查一次。
- API 失败使用队列级重试，不是单张图片单独冷却。
- 重试序列：立即、1 分钟、2 分钟、3 分钟、5 分钟、30 分钟、1 小时。
- 成功后清空该队列的失败序列。
- UI 提供暂停/开始和冷却期立即重发。

## 7. 日志与存储

本机路径：

- 活动日志：`%LOCALAPPDATA%\SuperGuider\activity-log.md`
- API 请求日志：`%LOCALAPPDATA%\SuperGuider\api-request-log.md`
- 私密设置：`%LOCALAPPDATA%\SuperGuider\private-settings.json`
- 截图目录：`%LOCALAPPDATA%\SuperGuider\screenshots`
- SQLite：`%LOCALAPPDATA%\SuperGuider\superguider.sqlite3`

API 日志必须包含：endpoint、model、status、content-type、脱敏请求体、原始响应体、提取出的模型消息内容。API Key 不记录，图片 base64 省略。

## 8. 休息与过滤

- 5 分钟无键鼠活动进入 `休息`，写一条休息活动行。
- 休息期不自动截图，不触发稳定截图和三分钟兜底截图。
- 新活动恢复后重新读取当前前台窗口。
- Alt+Tab 期间及结束后约 1200ms 抑制前台切换记录和稳定截图。
- Explorer shell 空状态、任务切换、Program Manager 等不写用户活动。

## 9. 当前已知边界

- `src/App.tsx` 仍承担主状态机和页面 UI，后续可以继续拆 `analysis` 和 `pages`。
- 正式自动任务分析仍关闭，只保留测试 run。
- 通知质量仍需迭代，避免显而易见或烦人的提醒。

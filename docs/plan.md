# SuperGuider 开发计划

更新时间：2026-06-28

## 已完成

- Tauri + React + TypeScript 桌面应用。
- 状态页、详情页、设置页、右下角通知气泡。
- 私密设置文件：API URL、API Key、截图模型、任务导航模型、应用监控权限。
- 应用权限拆分保存：应用监控保存不覆盖 API/模型字段。
- Windows 前台窗口监听、标题变化监听、全局键鼠 hook。
- Enter / Ctrl+C / 稳定前台 / 三分钟兜底 / 手动按钮触发上下文采样。
- 应用权限判断后截图，截图保存到本机目录。
- 截图文件命名：时间在前，应用/窗口信息在后。
- 截图理解模型返回 `summary`、`detailText`、`hoverPoint`。
- 活动日志和 API 请求日志。
- 详情页时间范围、今天快捷按钮、日志表格解析。
- Explorer shell 空状态过滤、终端/浏览器展示归一化。
- 5 分钟无活动进入休息期。
- Alt+Tab 抑制前台切换噪音。
- 队列级失败重试：立即、1 分钟、2 分钟、3 分钟、5 分钟、30 分钟、1 小时。
- 测试专用任务分析模块：命名 run、时间范围、按分钟批次、原始回复查看。
- 任务分析 schema 改为 `results[]`，支持一次返回多任务/多阶段。
- 代码初步拆分：`src/modules/settings.ts`、`src/modules/logs.ts`、`src/modules/testAnalysis.ts`。
- 新增 `docs/function-index.md` 作为 function 级功能索引。

## 当前架构现状

`src/App.tsx` 仍是主编排层，负责 React 状态机、页面渲染、队列调度、Tauri invoke 和用户交互。纯逻辑已优先拆出：

- 设置/权限：`src/modules/settings.ts`
- 日志解析：`src/modules/logs.ts`
- 测试任务分析状态：`src/modules/testAnalysis.ts`
- AI 契约：`src/aiContract.ts`

## 下一步建议

1. 继续拆 `src/App.tsx`：
   - `modules/analysis.ts`：截图分析和任务分析上下文构造、任务记忆更新。
   - `pages/StatusPage.tsx`、`pages/DetailsPage.tsx`、`pages/SettingsPage.tsx`。
   - `modules/queues.ts`：队列重试、暂停、冷却、正在处理状态。
2. 给 `src/modules/settings.ts`、`src/modules/logs.ts`、`src/aiContract.ts` 增加单元测试。
3. 补自动化测试：以 `docs/function-index.md` 的 function 调用链为用例目录。
4. 继续优化任务分析提示质量：避免显而易见、烦人、无引导价值的提示。
5. 正式自动任务分析恢复前，需要先确认 token 成本、触发条件和通知质量。

## 验证命令

```bash
npm run build
cargo check
```

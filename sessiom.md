# DataPilotAgent 开发会话记录

claude --resume 633df6b0-eed8-4504-bd23-ab7fa8125a1f

---

## M2 Agent 循环 + 工具集（任务 #10）— 2026-08-25 ✅

**交付文件**：`backend/app/services/sql_engine.py`、`backend/app/agents/sandbox.py`、`backend/app/agents/chart_builder.py`、`backend/app/agents/tools.py`（ToolEngine）、`backend/app/services/chat_service.py`（Agent loop 重写）、`backend/app/api/chat.py`（`POST /api/chat/execute`）。

### 单元自测（不依赖 LLM）：21/21 PASS
- **sql_engine**：SQL 类型判定（select/write/unsupported、多语句）；sqlite 附件路由（SELECT + max_rows 截断 total 正确、写操作拦截 SqlNeedsConfirmation、allow_write DELETE 提交且 affected_rows=10）；缺失附件 DB 报 SqlRoutingError。
- **sandbox**：print 捕获（`总金额: 18.5`）；`return_table(df)` 生成结果表；`import os` 被白名单拒绝；`while True` 在 ~5s 被 CPU 限制杀掉。
- **chart_builder**：bar 聚合 3 分类；pie 顺序按首次出现（梨/苹果/香蕉）；heatmap → matrix；pie 多 measure 抛 ChartError。

### 端到端自测（真实 DeepSeek-v4-flash，SSE 全链路）：15/15 PASS
1. **纯文本**：block_start(text) → token 流 → block_end → done（usage 正确累计）。
2. **run_sql 附件查询**：LLM 自动调 run_sql → table block（数据回填、聚合正确）→ done。
3. **create_chart**：LLM 以 `source_block_id` 引用上一步结果 → chart block（bar，series 值 = 梨 15.5 / 苹果 77.5 / 香蕉 26.0，与 pandas 聚合一致）。
4. **run_python 专项**：run_sql → 结果注入 df1 → LLM 调 run_python（`df1['amount'].sum()` + return_table）→ 新 table block 回填。
5. **写操作确认流**：LLM 先 run_sql 查影响范围 → request_confirmation 卡片（operation=execute_sql、risk_level=high、SQL 正确）→ SSE 以 done 正常关闭（协议 §3：confirmation 生成后结束本轮 SSE）→ `POST /api/chat/execute confirm` → affected_rows 结果 block（parent_block_id 关联卡片）+ 数据库实际删除 → `cancel` → 卡片 status=rejected、confirmed=False、数据未变动。

### 过程中确认的协议点
- **确认卡片后 SSE 以 done 结束**：协议原文「调用即生成 confirmation block 并结束本轮 SSE」（§4.2）+「done/error 后服务端主动关闭流」（§3）——done 是唯一正常关闭信号，前端收到后停在卡片等 execute。
- **run_python 与 run_sql 对计算任务等价**：LLM 可自由选择工具；「用 python 计算」在无强约束提示下可能仍走 run_sql（合法）。验收以「工具结果回填 table block」为准。
- **已知限制**：历史回放仅 text 摘要，不含工具调用回放（已记录，后续版本可加）。

### 遗留
- `data/tmp/sandbox_runner.py` 为模板缓存文件，模板修改后需 `rm` 一次再运行（否则 runner 过期）。
- 测试会话数据已清理；测试脚本留存 `/tmp/t10_unit.py`、`/tmp/t10_e2e.py`。

---

## M3 附件引擎（任务 #12）— 2026-08-25 ✅

**交付文件**：`backend/app/api/upload.py`（完整实现，替换 stub）、`backend/app/tasks/executors.py` + `worker.py`（file_parse executor 注册）、`backend/app/services/attachment_service.py`（agent 交付，验证通过）。

### 端到端自测：9/9 PASS + 全链路闭环
1. **上传** `POST /api/upload`（multipart: file + session_id）→ 附件记录 + file_parse 任务。
2. **解析状态轮询** `GET /api/upload/{id}/status` → ready（任务 success 100%、file_size、parsed_schema 回填：table_name=`att_{id}`、row_count=10、列类型推断 订单号=TEXT / 金额=REAL / 下单日期=DATE / 是否发货=INTEGER）。
3. **SQLite 落表**：`data/tmp/{session_id}.db` 中 att_ 表 10 行、金额 SUM=119.0、数值列类型正确。
4. **会话隔离**：无附件库的会话查询 att_ 表不产生数据（LLM 说明无数据 / 路由错误，绝不越权读他人附件库）。
5. **归属校验**：不存在的附件 404；非法 ID 400。
6. **非法扩展名** 400 中文提示。
7. **全链路闭环**：真实上传 sales.csv → chat/stream run_sql 查询 att_ 表 → table block（LLM 还自动追加了 chart）。

### 修复的 bug
- **循环导入导致上传 500**：executors.py 模块级注册 file_parse 与 attachment_service 顶层 `from app.tasks.executors import TaskCancelled` 互相依赖 → ImportError → 上传接口 500。修复：注册函数移入 worker.py 启动路径显式调用（`register_file_parse_executor()`）。
- **`exc.message` AttributeError → 500**：AttachmentError 只有 `status_code` 属性无 `message`。修复：API 层改 `str(exc)`。

### 已知遗留
- 会话删除时 MinIO 附件对象与 attachments 记录的清理依赖 DB CASCADE + 过期策略（expires_at 7 天）；后台清理任务 MVP 范围外。
- `GET /api/upload/{id}/status` 的 task_brief 中 file_size 在任务未结束时为 null（由任务 result 反查，正常）。

---

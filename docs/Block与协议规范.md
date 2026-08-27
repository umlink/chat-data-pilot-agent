# DataPilotAgent Block 与协议规范

**版本**：v1.0
**日期**：2026-08-25
**定位**：前后端开发契约。定义 Block 内容结构、SSE 事件载荷、LLM 结构化输出协议（Agent 工具集）、附件执行引擎。《需求PRD》与《技术方案设计》中引用本文档，冲突时以本文档为准。

---

## 目录

1. Block 通用结构
2. 各类型 Block 的 content 定义
3. SSE 事件协议
4. LLM 结构化输出协议（Agent 工具集）
5. 附件执行引擎
6. 前端渲染映射与状态流转

---

## 1. Block 通用结构

```typescript
interface Block {
  id: string;                 // UUID，服务端生成，前端据此定位更新
  type: BlockType;
  status: BlockStatus;
  content: object;            // 结构随 type 不同，见第 2 章
  actions?: BlockAction[];    // 可用操作，前端渲染为按钮
  parent_block_id?: string;   // 关联父 block（如确认卡片触发的执行结果）
  created_at: string;         // ISO 8601
}

type BlockType =
  | 'text' | 'code' | 'table' | 'chart' | 'confirmation'
  | 'insights' | 'suggestions' | 'progress' | 'error' | 'attachment'
  | 'sources';

type BlockStatus =
  | 'pending' | 'running' | 'completed'
  | 'failed' | 'cancelled' | 'rejected';

interface BlockAction {
  action: 'edit' | 'execute' | 'copy' | 'retry' | 'export'
        | 'confirm' | 'cancel' | 'preview' | 'replace' | 'remove';
  label: string;              // 按钮文案
  payload?: object;           // 触发时提交给后端的参数（如 task_id、block_id）
}
```

**通用约定**：

- **唯一事实源**：blocks 以 JSONB 数组存储于 `messages.blocks`，服务端持久化后前端才可见终态；SSE 只是加速通道。
- **不可变追加**：历史 block 的内容不原地重写；重新执行产生新 block，并以 `parent_block_id` 关联。可更新的只有 `status` 与 `content` 中的进度类字段（见第 6 章状态流转表）。
- **体积上限**：单条消息 blocks 序列化后不超过 1MB；table 行数超过 `MAX_QUERY_ROWS` 时截断并标记 `truncated`，完整结果通过导出接口获取。
- **ID 生成**：所有 block id 由服务端生成（UUID v4），客户端本地乐观渲染时可先占位，收到 `block_start` 后按 `temp_id` 映射替换（SSE 事件 data 可携带 `temp_id`）。

---

## 2. 各类型 Block 的 content 定义

以下 TypeScript 定义同时是后端 Pydantic 模型与前端类型的规范来源。

### 2.1 text

```typescript
interface TextContent {
  text: string;               // Markdown；流式阶段由 token 事件增量追加
}
```

### 2.2 code

```typescript
interface CodeContent {
  language: 'sql' | 'python';
  code: string;
  editable: boolean;          // 默认 true
  execution?: {               // 由「执行」动作回填
    task_id?: string;
    status?: 'running' | 'success' | 'failed';
    error?: string;
    duration_ms?: number;
  };
}
```

### 2.3 table

```typescript
interface TableColumn {
  key: string;                // 列标识（SQL 别名 / 附件列名）
  label: string;              // 展示名
  dtype: 'number' | 'string' | 'date' | 'boolean';
}

interface TableContent {
  columns: TableColumn[];
  rows: Record<string, any>[];    // 行对象数组，key 对应 columns.key
  total: number;                  // 符合条件的总行数（截断前）
  truncated: boolean;             // 是否因 MAX_QUERY_ROWS 截断
  query?: string;                 // 溯源 SQL（结果溯源入口）
}
```

### 2.4 chart

存储**结构化数据**而非图表库 option——图表库细节留在前端（M4 落地为 recharts / shadcn Chart），后端只描述"数据与语义"，同时保证导出与重新渲染的一致性。

```typescript
interface ChartSeries {
  name: string;                  // 系列名（图例）
  x: (number | string)[];        // x 轴 / 分类值
  y: number[];                   // 数值，与 x 等长
}

interface ChartContent {
  chart_type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap';
  title?: string;
  series: ChartSeries[];         // pie：单系列；heatmap：忽略，使用 matrix
  matrix?: {                     // heatmap 专用
    x_categories: string[];
    y_categories: string[];
    values: number[][];          // [y_index][x_index]
  };
  x_label?: string;
  y_label?: string;
  source_block_id?: string;      // 数据来源 table block（溯源）
  query?: string;                // 溯源 SQL
}
```

### 2.5 confirmation

```typescript
interface ConfirmationContent {
  operation: 'execute_sql' | 'execute_python' | 'delete_attachment' | 'truncate_table';
  title: string;                  // 卡片标题
  description: string;            // 操作说明 + 预计影响范围（行数估算）
  sql?: string;                   // 待执行的语句预览
  risk_level: 'high' | 'medium';
  confirmed?: boolean;            // 用户操作后回填（true=确认，false=拒绝）
  result_block_id?: string;       // 确认后执行产生的结果 block
}
```

### 2.6 insights

```typescript
interface InsightsContent {
  items: {
    title: string;                // 一句话结论
    detail: string;               // 支撑说明（数字、对比）
    severity?: 'info' | 'positive' | 'warning';
  }[];
}
```

### 2.7 suggestions

```typescript
interface SuggestionsContent {
  items: {
    text: string;                 // 按钮文案
    message: string;              // 点击后作为用户消息发送的内容
  }[];
}
```

### 2.8 progress

```typescript
interface ProgressContent {
  task_id: string;
  steps: { name: string; status: 'pending' | 'running' | 'done' | 'failed' }[];
  percent: number;                // 0-100
  current_step?: string;
  cancellable: boolean;
}
```

### 2.9 error

```typescript
interface ErrorContent {
  code: 'SQL_SYNTAX_ERROR' | 'SQL_TIMEOUT' | 'DATASOURCE_ERROR'
      | 'LLM_ERROR' | 'PARSE_ERROR' | 'UPLOAD_ERROR'
      | 'TASK_CANCELLED' | 'INTERNAL_ERROR';
  message: string;                // 用户可读信息（中文）
  detail?: string;                // 原始错误（DB 报错 / 堆栈），默认折叠展示
  suggestion?: string;            // 修正建议
  retryable: boolean;
}
```

### 2.10 attachment

```typescript
interface AttachmentContent {
  attachment_id: string;
  file_name: string;
  file_type: 'csv' | 'excel' | 'json';
  file_size: number;              // 字节
  status: 'uploading' | 'parsing' | 'ready' | 'failed';
  sheet_name?: string;            // Excel：解析使用的第一个 sheet 名
  row_count?: number;
  columns?: { name: string; dtype: string }[];
  preview_rows?: Record<string, any>[];   // 前 50 行
  error?: string;                 // status=failed 时
  removed?: boolean;              // 用户已移除（block 保留但引用失效；POST /upload/{id}/block-state 持久化）
}
```

附件 block 的状态变更（替换/移除）通过 `POST /api/upload/{id}/block-state` 持久化到
`messages.blocks`（body：`message_id`/`block_id`/`patch`，patch 键白名单且 `null` 表示清空
该字段），与「不可变追加」不冲突——本类变更仅更新可更新字段（见 6.2 状态流转表）。

### 2.11 sources（数据来源 / 证据链）

```typescript
interface SourceItem {
  label: string;          // 展示名：『数据源：xx』/ 表名 / 『查询 N』
  sql?: string;           // 有则渲染为可点击「查看查询 SQL」
}

interface SourcesContent {
  items: SourceItem[];
}
```

- 由服务端**确定性推导**（不依赖 LLM 格式化）：数据源 = run_sql 使用的数据源（或会话所选/默认）；
  表名 = 各 SQL 的 FROM/JOIN 解析去重；查询 = 本回合去重后的 SQL（run_sql 调用 + table/chart 的 query）。
- 顺序：数据源 → 表名 → 查询；sql 项前端渲染为可点击 chip（复用 SqlQueryDialog）。
- 仅在正常完成路径（非确认中断）追加，置于 text 与 table/chart 之后、suggestions 之前。

---

## 3. SSE 事件协议

### 3.1 传输格式

`POST /api/chat/stream` 与 `GET /api/tasks/{id}/stream` 返回 `text/event-stream`，每个事件：

```
event: <事件类型>
id: <seq>                     // 会话内单调递增，从 1 开始
data: <JSON 载荷>

```

（空行结束一个事件。）

### 3.2 事件类型与载荷

| 事件 | data 结构 | 说明 |
|------|-----------|------|
| `token` | `{ block_id, temp_id?, content }` | 向 text block 追加文本片段 |
| `block_start` | `{ block_id, temp_id?, type, content?, actions? }` | 新 block 开始，可携带初始 content |
| `block_update` | `{ block_id, patch }` | content 局部更新（Merge Patch 语义，见 3.3） |
| `block_end` | `{ block_id, status }` | block 到达终态 |
| `task_status` | `{ task_id, status, percent?, current_step? }` | 任务进度推送 |
| `error` | `{ code, message }` | 会话级错误（整条消息失败） |
| `done` | `{ message_id, usage }` | 消息完成；`usage: { prompt_tokens, completion_tokens, total_tokens }` |

### 3.3 block_update 语义

`patch` 遵循 **JSON Merge Patch（RFC 7396）**：

- 顶层字段与现有 `content` 浅合并，嵌套对象递归合并
- `null` 值删除对应字段
- 数组整体替换（不做元素级合并）

示例--progress block 更新步骤状态：

```json
{ "block_id": "b-123", "patch": { "percent": 45, "current_step": "执行查询" } }
```

### 3.4 可靠性与恢复

- **乱序丢弃**：前端记录已处理的最大 `id`，收到更小的 id 直接丢弃（重连重放场景）。
- **断线恢复**：SSE 断开后重连前，先调 `GET /api/sessions/{id}/messages` 全量对齐本地消息与 block 终态，再续订任务 SSE（`GET /api/tasks/{id}/stream`）。**不做事件级续传**，MVP 以终态对齐代替。
- **心跳**：服务端每 15 秒发送注释行 `: ping\n\n` 防止代理空闲断连。
- **连接关闭**：`done` 或 `error` 事件后服务端主动关闭流；前端收到后结束本次请求。

### 3.5 执行类动作的返回

`POST /api/chat/execute`（编辑后执行 SQL / 确认卡片 / 重试）为普通 JSON 响应：

```json
{ "code": 0, "data": { "task_id": "t-456", "block_id": "b-789" }, "message": "ok" }
```

前端收到后：立即在目标位置渲染 pending/running block，并通过任务 SSE 订阅进度。

---

## 4. LLM 结构化输出协议（Agent 工具集）

### 4.1 编排模型

`ChatService` 对单条用户消息的编排采用 **Agent 循环 + 工具调用**（意图识别隐含在工具选择中，不做独立的意图分类调用）：

```
组装上下文（历史 + 数据源 schema + 附件 schema）
  ↓
循环（上限 8 轮）：
  LLM 决策 → 调用工具 / 输出自然语言
    ├─ 调用工具：服务端执行 → 结果以 tool 消息回填 → 继续循环
    ├─ request_confirmation：生成确认卡片 → 本轮对话终止（等待用户决策）
    └─ 自然语言输出：token 流式推送 → done
```

### 4.2 工具定义

#### run_sql

```typescript
{
  name: 'run_sql',
  description: '执行 SQL 查询。SELECT 语句直接执行；写操作会被安全策略拦截并转为确认流程',
  input_schema: {
    sql: string,                  // 完整 SQL 语句
    datasource_id?: string,       // 省略时用主数据源；att_ 开头的表自动路由到附件引擎
    purpose?: string              // 一句话说明（用于分析与审计日志）
  },
  // 返回给 LLM 的 tool 结果
  output: {
    columns: TableColumn[],
    rows: Record<string, any>[],  // 最多 MAX_QUERY_ROWS 行
    total: number,
    truncated: boolean,
    duration_ms: number,
    error?: string
  }
}
```

副作用：成功后在消息中追加 `table` block（LLM 无需搬运数据）。

#### run_python

```typescript
{
  name: 'run_python',
  description: '在受限沙箱中执行 Python 分析代码（pandas/numpy），输入为已存在的 table block',
  input_schema: {
    code: string,
    input_block_ids: string[]     // 引用的 table block，注入为 DataFrame 变量 df1/df2...
  },
  output: {
    text?: string,                // print 输出（截断至 4000 字符）
    result_table_id?: string,     // 若代码调用 return_table(df)，生成的新 table block
    error?: string
  }
}
```

沙箱约束见技术方案 2.8；跨源合并（主源 + 附件）通过本工具实现。

#### create_chart

```typescript
{
  name: 'create_chart',
  description: '基于已有查询结果生成图表。服务端负责聚合与组装，LLM 只指定图表语义',
  input_schema: {
    source_block_id: string,      // 数据来源 table block
    chart_type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap',
    dimension: string,            // x 轴列名（分类/时间）
    measures: {
      column: string,
      agg?: 'sum' | 'avg' | 'count' | 'max' | 'min',   // 省略 = 不聚合（行级值）
      name?: string               // 系列名
    }[],
    title?: string
  },
  output: { block_id: string, chart: ChartContent }
}
```

规则：pie 至多 1 个 measure；heatmap 的 dimension/measures 分别映射 matrix 的 x/y 分类。服务端用 pandas 按 dimension 聚合 measures 后填充 `ChartContent`。

#### request_confirmation

```typescript
{
  name: 'request_confirmation',
  description: '危险操作前请求用户确认。调用后本轮对话终止，等待用户在确认卡片上决策',
  input_schema: {
    operation: 'execute_sql' | 'execute_python' | 'delete_attachment' | 'truncate_table',
    title: string,
    description: string,          // 必须包含影响范围估算（如预计影响行数）
    sql?: string,
    risk_level: 'high' | 'medium'
  },
  output: null                    // 无同步输出；用户决策后经 POST /api/chat/execute 触发新任务
}
```

**注意**：此工具不阻塞等待。调用即生成 `confirmation` block（status=pending）并结束本轮 SSE；用户点击确认/取消后由 execute 接口驱动后续执行，结果 block 以 `parent_block_id` 关联回确认卡片。

### 4.3 消息与持久化

- 内部消息统一 OpenAI 风格（`system` / `user` / `assistant` / `tool`），Anthropic 适配器负责格式转换（技术方案 2.5）。
- 工具调用与结果记录在 assistant 消息 `metadata.tool_calls`（JSONB），用于上下文重放与审计；**不**生成用户可见 block。
- 用户可见的内容只来自：LLM 自然语言（text block）与工具副作用（table/chart/confirmation block）。

### 4.4 上下文管理

| 项 | 规则 |
|----|------|
| 历史轮数 | 最近 10 轮完整保留；更早的 table/chart block 在进入 LLM 上下文时压缩为摘要（列名 + 行数 + 查询语句） |
| schema 注入 | 主数据源全部表结构（表名、列名、类型、注释）+ 每表 3 行采样数据 |
| 附件注入 | `att_{attachment_id}` 的列名/类型/行数/sheet 名，并声明「附件表位于独立引擎，跨源 JOIN 需用 run_python 合并」 |
| 上下文预算 | schema + 历史总量控制在 8K token 内，超出优先压缩采样数据 |
| 澄清机制 | 问题缺少必要参数（时间范围、指标口径等）时，LLM 不调用工具，直接输出澄清文本 + suggestions block（提示词中明确要求） |

### 4.5 降级：JSON 模式

不支持 tool calling 的模型：在 system 提示词尾部附加输出协议：

```
你必须以 JSON 输出，二选一：
{"tool": "<工具名>", "arguments": {...}}
{"text": "<面向用户的中文回复>"}
```

解析失败自动重试 1 次（附加错误提示），仍失败则按 `LLM_ERROR` 生成 error block。

### 4.6 Token 统计

每次 LLM 调用的 usage 累计到会话级计数器；`done` 事件返回本条消息的合并 usage，同时写入 assistant 消息 `metadata.usage`，前端在消息底部展示「消耗约 X tokens」。

---

## 5. 附件执行引擎

附件分析的完整路径（与技术方案 4.3 配合阅读）：

### 5.1 管道

```
上传（流式写 MinIO）
  -> file_parse 任务（Worker）
     -> pandas 解析（CSV / Excel 首个 sheet / JSON）
     -> 类型推断与映射（5.2）
     -> 导入会话级 SQLite：data/tmp/{session_id}.db，表名 att_{attachment_id}
     -> 更新 attachments.parsed_schema
  -> attachment block 状态 -> ready（含 preview_rows 前 50 行）
```

### 5.2 类型映射

| pandas dtype | SQLite 类型 | TableContent.dtype |
|--------------|-------------|--------------------|
| int64 / Int64 | INTEGER | number |
| float64 | REAL | number |
| datetime64 | TEXT（ISO 8601） | date |
| bool | INTEGER（0/1） | boolean |
| object / string | TEXT | string |

### 5.3 限制与错误

- 单附件上限：100 万行或解析内存 200MB，超限任务标记 `failed`（`PARSE_ERROR`，提示拆分文件）
- 空文件 / 全空列：列保留，dtype 回退 string
- 列名冲突（SQLite 大小写不敏感）：后出现的同名列自动加后缀 `_2`、`_3`，并在 parsed_schema 中记录原名

### 5.4 SQL 路由

执行器解析 SQL 中 FROM / JOIN 引用的表名：

| 引用情况 | 路由 |
|---------|------|
| 全部为 `att_*` 表 | 会话级 SQLite 引擎 |
| 全部为主数据源表 | 主数据源引擎 |
| 混合引用 | 拒绝执行，返回 error block（`SQL_SYNTAX_ERROR` 语义：跨引擎 JOIN 不支持），提示 AI 改用 run_python 两步合并 |

### 5.5 生命周期清理

- 会话删除：删除 MinIO 前缀 `attachments/{session_id}/`、删除临时库文件、级联删除记录
- 过期清理：每日定时任务删除 `expires_at < now` 的附件（对象 + 临时表 + 记录）
- 孤儿清理：每日扫描 `data/tmp/` 中无对应会话的库文件（服务异常重启残留）

---

## 6. 前端渲染映射与状态流转

### 6.1 渲染映射

| Block type | 组件 | 核心交互 |
|-----------|------|---------|
| text | TextBlock（react-markdown） | 复制 |
| code | CodeBlock（Monaco） | 编辑 / 执行 / 复制 |
| table | TableBlock（@tanstack/react-virtual） | 排序、筛选、分页、导出、复制、溯源 |
| chart | ChartBlock（recharts / shadcn Chart） | 悬停提示、缩放、导出 PNG/SVG/PDF |
| confirmation | ConfirmationBlock | 确认 / 取消 |
| insights | InsightsBlock | 无 |
| suggestions | SuggestionBlock | 点击发送 message |
| sources | SourcesBlock | 点击查看查询 SQL |
| progress | ProgressBlock | 取消 / 失败重试 |
| error | ErrorBlock | 重试（retryable 时）、展开 detail |
| attachment | AttachmentBlock | 预览 / 替换 / 移除 |

### 6.2 状态流转表

| Block type | 合法状态序列 | 可更新字段 |
|-----------|-------------|-----------|
| text | running -> completed（流式中为 running） | content.text（token 追加） |
| code | completed ->（执行后）execution.status 变化 | content.execution.* |
| table | completed（终态） | 无 |
| chart | completed（终态） | 无 |
| confirmation | pending -> approved / rejected（用户决策） | content.confirmed、content.result_block_id |
| insights | completed | 无 |
| suggestions | completed | 无 |
| sources | completed | 无 |
| progress | running -> completed / failed / cancelled | content.percent、current_step、steps[].status |
| error | completed（终态，内容即错误） | 无 |
| attachment | uploading -> parsing -> ready / failed | content.status 及解析结果字段 |

### 6.3 前端更新实现要点

- Zustand 中消息列表按 block id 建立索引，`block_update` 只 patch 对应 block，避免整列表重渲染。
- `token` 事件对 text block 做缓冲合并（50ms / 10 token 批量 flush）后再 setState。
- 会话切换时取消进行中的 SSE（AbortController），消息终态以 REST 全量接口为准。




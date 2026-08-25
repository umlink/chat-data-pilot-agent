# DataPilotAgent MVP 产品需求文档（PRD）

**版本**：v1.2  
**日期**：2026-08-25  

---

## 目录

1. 产品概述
2. 目标用户
3. 核心功能需求
4. 消息模型与交互设计
5. 产品体验细节
6. 技术架构
7. 后端功能设计
8. 前端技术细节
9. LLM 双协议支持与配置抽离
10. 部署架构
11. 非功能需求
12. 里程碑
13. 验收标准

---

## 一、产品概述

### 1.1 产品定位

DataPilotAgent 是一个 AI 驱动的智能数据分析平台。用户通过自然语言对话完成数据查询、分析、可视化和洞察提取，无需编写代码或掌握复杂 BI 工具。

### 1.2 MVP 目标

- 用最小技术复杂度验证核心价值：**自然语言数据分析**
- 支持多数据源接入（单选数据源进行对话分析）
- 实现多格式消息渲染与可交互分析流程
- 具备图表生成与多格式导出能力
- 支持 LLM 双协议（OpenAI / Anthropic）与后台配置热更新
- 提供完善的日志管理与后台查看功能

### 1.3 MVP 非目标

- 不做团队协作与多租户权限体系
- 不做收藏夹与分享链接（只读分享）
- 不做工作流编排
- 不做预测建模 / 机器学习
- 不做移动端适配
- 不做实时数据流接入
- 不提供国际化，仅支持中文

---

## 二、目标用户

| 用户角色 | 核心诉求 | 使用场景 |
|---------|---------|---------|
| 业务分析师 | 快速获取数据答案 | 日常取数、报表分析 |
| 运营人员 | 理解业务数据趋势 | 活动效果、用户行为 |
| 数据开发 | 辅助 SQL 编写与调试 | 复杂查询、数据验证 |

---

## 三、核心功能需求

### 3.1 智能对话分析（核心模块）

#### 3.1.1 对话能力

- 多轮对话，支持上下文理解
- 流式响应（SSE），逐 token 展示
- 对话历史保存与恢复
- 会话自动生成标题（AI 生成一句话摘要）
- 上下文长度接近上限时，提示用户新建会话或总结上下文

#### 3.1.2 消息类型（Block 数组）

AI 回复支持以下内容块（Block）的任意组合：

| Block 类型 | 说明 | 交互能力 |
|-----------|------|---------|
| `text` | 解释性文字 / Markdown | 复制 |
| `code` | SQL / Python 代码块 | 编辑、执行、复制 |
| `confirmation` | 操作确认卡片 | 确认 / 取消 |
| `table` | 查询结果表格 | 排序、筛选、分页、导出、复制 |
| `chart` | 可视化图表 | 交互、导出 |
| `insights` | 数据洞察摘要 | 无 |
| `suggestions` | 追问建议按钮 | 点击发起新对话 |
| `progress` | 任务进度 | 实时更新、可取消 |
| `error` | 错误提示 | 重试 |
| `attachment` | 附件引用 | 预览、替换、移除 |

#### 3.1.3 SQL 编辑交互

- AI 生成 SQL 后展示代码块，附 [编辑] [执行] 按钮
- 默认只读，语法高亮
- 点击编辑后切换为可编辑状态（Monaco Editor）
- 修改后可重新执行，执行状态实时展示
- 结果以新 Block 插入对话流
- 保留当前会话内所有执行的 SQL 历史，可统一查看

#### 3.1.4 确认流程

- 涉及耗时操作、大量数据扫描或写操作时，AI 返回确认卡片
- 确认卡片包含操作说明、预计影响范围
- 用户确认后才执行
- 支持“始终允许此类操作”偏好设置（在系统配置中）
- 系统自动分析 SQL 类型和影响范围，规则可配置，不依赖 AI 判断

#### 3.1.5 附件上传

- 支持上传 CSV、Excel、JSON 文件
- 上传后作为临时数据源参与分析（当前会话内有效）
- 附件在对话中有明确状态展示：上传中 → 解析中 → 已就绪 / 解析失败
- 支持附件预览（前 N 行数据）
- 支持附件替换，替换后关联分析自动更新
- 附件与会话绑定，会话删除时附件一并清理；附件最大保留 7 天，过期自动删除
- 附件解析后导入**会话级临时 SQLite 表**，与数据库数据源统一走 SQL 分析路径（详见《Block与协议规范》）

#### 3.1.6 追问建议

- AI 回复后自动生成 2-3 个相关追问按钮
- 用户点击按钮一键继续分析
- 建议基于当前数据结果和分析上下文生成

#### 3.1.7 AI 澄清机制

- 用户问题模糊、缺少必要参数（时间范围、指标定义等）时，AI 主动提出澄清问题
- 不猜测执行，避免错误分析
- 澄清问题以可点击选项形式呈现，减少用户输入成本

### 3.2 数据源管理

#### 3.2.1 数据源类型

| 类型 | 说明 | MVP 支持 |
|------|------|---------|
| 文件上传 | CSV、Excel、JSON | ✅ |
| PostgreSQL | 关系型数据库 | ✅ |
| MySQL | 关系型数据库 | ✅ |
| SQLite | 本地文件 | ✅ |

#### 3.2.2 数据源选择（单选）

- 对话前全局选择**一个**当前数据源，作为本次会话的主数据源
- 选中数据源以 Tag 形式展示在输入框上方，可随时更换
- 附件上传后自动成为临时附加数据源，但不改变主数据源选择
- 切换会话时保留上次选择（会话级记忆）

#### 3.2.3 数据源配置

- 连接信息配置（主机、端口、用户名、密码、数据库名）
- 连接测试按钮，验证可用性
- Schema 自动识别与展示
- 数据预览（前 N 行）
- 连接状态监控：断开或异常时在界面上明显标记
- Schema 变更检测：表结构变化时提示并更新缓存

#### 3.2.4 数据新鲜度

- 展示数据源最后同步/更新时间
- 文件类数据源展示上传时间
- 数据库数据源展示最后连接时间

### 3.3 图表生成与导出

#### 3.3.1 自动图表推荐

- 根据查询结果的数据结构自动推荐图表类型
- 支持类型：折线图、柱状图、饼图、散点图、热力图
- 推荐依据：字段类型（数值/时间/分类）、数据分布、行数

#### 3.3.2 图表交互

- 缩放、平移、悬停提示
- 图表配置修改：颜色、标签、轴设置、标题
- 多图表组合展示

#### 3.3.3 导出能力

| 导出对象 | 支持格式 | 说明 |
|---------|---------|------|
| 图表 | PNG、SVG、PDF | 高质量导出 |
| 数据表格 | CSV、Excel、JSON | 当前筛选结果 |
| 对话记录 | Markdown、PDF | 完整对话内容 |

### 3.4 任务管理

#### 3.4.1 任务类型与执行模式

| 任务类型 | 执行模式 | 超时 | 进度展示 |
|---------|---------|------|---------|
| 简单查询 | 同步流式 | 10s | 无 |
| 数据分析 | 异步 | 60s | 步骤进度 |
| 复杂分析 | 异步 | 300s（可配置） | 详细进度 + 可取消 |
| 文件解析 | 异步 | 30s | 上传进度 |

#### 3.4.2 任务状态机

```
PENDING（待处理）→ RUNNING（执行中）→ SUCCESS（成功）/ FAILED（失败）/ CANCELLED（取消）
```

- 所有状态变更通过 SSE 实时推送
- 失败任务支持一键重试
- 超时自动标记失败
- 服务重启后未完成任务恢复为 PENDING
- 对于写操作任务，恢复时若无法确定执行结果，标记为“需人工确认”

#### 3.4.3 任务恢复机制

- 应用启动时，将中断任务重新入队
- 超时任务自动标记失败
- 任务详情持久化，不依赖内存
- 查询类任务可安全重试；写操作任务需幂等设计或人工确认

### 3.5 系统配置管理

#### 3.5.1 LLM 配置

| 配置项 | 说明 | 生效方式 |
|--------|------|---------|
| 提供商 | OpenAI / Anthropic | 新会话生效 |
| 协议 | OpenAI 协议 / Anthropic 协议 | 新会话生效 |
| 模型名称 | gpt-4o / gpt-4o-mini / claude-3-5-sonnet 等 | 新会话生效 |
| API Key | 密钥，加密存储，脱敏显示 | 即时生效 |
| Base URL | 自定义 API 地址 | 即时生效 |
| 温度 | 0-1 | 新会话生效 |
| 最大输出 Token | 限制单次回复长度 | 新会话生效 |
| 请求超时 | 秒 | 即时生效 |
| 重试次数 | 失败自动重试 | 即时生效 |
| 流式输出 | 开关 | 即时生效 |

#### 3.5.2 全局系统配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 查询结果行数上限 | 1000 | 单次查询最多返回行数 |
| 危险 SQL 操作 | 需确认 | DROP / ALTER / TRUNCATE / 大规模 UPDATE / DELETE |
| 禁止 SQL 操作 | 直接拦截 | DROP DATABASE 等 |
| 任务超时时间 | 300秒 | 复杂分析任务超时 |
| 文件上传大小限制 | 20MB | 附件上传 |
| 会话保留时长 | 30天 | 过期自动清理 |
| SQL 安全等级 | normal | strict / normal |
| 日志保留天数 | 30天 | 日志入库后保留时间 |

#### 3.5.3 热更新机制

- 配置存储于 PostgreSQL，Redis 缓存
- 修改后更新 DB → 删除 Redis 缓存 → 发布 Pub/Sub 通知
- 各服务节点订阅通知，清空本地缓存
- 进行中的会话沿用旧配置，新会话使用新配置
- 保存前支持“测试连接 / 测试对话”验证配置可用性
- 配置变更记录审计日志（谁在什么时候改了什么）

### 3.6 日志管理（新增）

#### 3.6.1 日志分类

| 日志类别 | 说明 | 示例 |
|---------|------|------|
| 系统日志 | 服务启动、停止、异常 | 服务重启、内存溢出 |
| 应用日志 | 业务操作记录 | 用户登录、数据源连接、任务创建 |
| AI 日志 | LLM 请求与响应摘要 | 模型名称、Token 用量、延迟 |
| 错误日志 | 错误与异常堆栈 | SQL 语法错误、网络超时 |
| 审计日志 | 配置变更、敏感操作 | 修改 LLM 配置、删除数据源 |

#### 3.6.2 日志入库

- 所有日志统一写入 PostgreSQL 日志表（按类别分表或单表带类别字段）
- 使用结构化日志格式（JSON），便于查询和分析
- 日志级别：DEBUG / INFO / WARNING / ERROR / CRITICAL
- 日志保留天数可配置（默认 30 天），过期自动清理

#### 3.6.3 管理后台日志查看

- 管理后台提供日志查看页面
- 支持按时间范围、日志类别、级别、关键字过滤
- 关键日志（ERROR、CRITICAL、审计日志）高亮显示
- 日志详情可展开查看完整堆栈或请求上下文
- 支持导出日志为 CSV

---

## 四、消息模型与交互设计

### 4.1 核心数据结构

```
Message（消息）
├── id
├── session_id（所属会话）
├── role（user / assistant / system）
├── blocks: Block[]（内容块数组）
├── created_at
└── metadata（附加信息）

Block（内容块）
├── type（text / code / table / chart / confirmation / ...）
├── content（具体内容，随 type 不同而不同）
├── status（pending / running / completed / failed / rejected）
├── actions（可用操作列表）
└── parent_block_id（关联的父 block，如确认后触发的执行）
```

> 各 Block 类型的 `content` 字段精确定义、SSE 事件载荷、LLM 结构化输出协议与附件执行引擎见 **docs/Block与协议规范.md**，该文档是前后端开发契约。

### 4.2 典型交互流程

#### 场景一：确认后执行 SQL

```
用户: "删除测试表中的脏数据"
  ↓
AI 返回: [
  { type: "text", content: "我生成了一条 DELETE 语句，请确认：" },
  { type: "code", language: "sql", content: "DELETE FROM ..." },
  { type: "confirmation", action: "execute_sql", status: "pending" }
]
  ↓
用户点击"确认执行"
  ↓
confirmation block 状态 → approved
  ↓
插入 progress block → 执行 → 替换为 result block
```

#### 场景二：上传附件分析

```
用户: [上传 sales.xlsx] + "分析月度销售趋势"
  ↓
用户消息 blocks: [
  { type: "attachment", file: "sales.xlsx", status: "uploading" },
  { type: "text", content: "分析月度销售趋势" }
]
  ↓
attachment 状态 → parsed
  ↓
AI 回复: [text block + chart block + insights block + suggestions block]
```

#### 场景三：SQL 编辑重执行

```
用户: "查询上个月销售额"
  ↓
AI 返回: [
  { type: "code", language: "sql", content: "SELECT ...", editable: true },
  { type: "table", data: [...] }
]
  ↓
用户点击 [编辑] → 修改 SQL → 点击 [执行]
  ↓
插入 progress block → 执行完成 → 在下方插入新的 table block
```

### 4.3 页面布局

```
┌─────────────────────────────────────────────────────────┐
│  Header: Logo | 会话标题 | 数据源选择器 | 设置          │
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│ 会话列表  │              对话区域                        │
│          │                                              │
│ 历史会话  │   ┌──────────────────────────────────┐     │
│          │   │  消息流（多类型 Block 渲染）      │     │
│ 新建会话  │   │                                  │     │
│          │   │  [text] [code] [table] [chart]   │     │
│ 搜索     │   │  [confirmation] [progress]       │     │
│          │   └──────────────────────────────────┘     │
│          │                                              │
│          │   ┌──────────────────────────────────┐     │
│          │   │  当前数据源 Tag（可更换）         │     │
│          │   │  [输入框]  [附件] [发送]         │     │
│          │   └──────────────────────────────────┘     │
├──────────┴──────────────────────────────────────────────┤
│  Footer: 当前任务状态 | 连接状态                        │
└─────────────────────────────────────────────────────────┘
```

---

## 五、产品体验细节

### 5.1 对话体验

- **AI 思考状态**：展示“正在理解问题 → 正在生成查询 → 正在执行”阶段提示
- **消息复制**：所有 Block 支持一键复制
- **重新生成**：AI 回复可一键重新生成，保留原回复
- **反馈机制**：点赞 / 点踩，用于优化 Prompt 和模型选择

### 5.2 分析透明化

- **分析日志**：展示 AI 分析步骤和中间 SQL
- **SQL 历史**：当前会话内所有执行的 SQL 可统一查看和管理
- **结果溯源**：点击表格 / 图表可查看对应查询语句

### 5.3 错误处理

| 错误类型 | 用户可见表现 | 处理机制 |
|---------|-------------|---------|
| AI 生成失败 | 错误 Block，显示原因 | 自动重试 1 次，可手动重试 |
| SQL 语法错误 | 代码 Block 标红 + 错误信息 | 用户可编辑后重试 |
| SQL 执行超时 | 错误 Block | 提示优化或缩小范围 |
| 附件解析失败 | 附件 Block 显示失败 | 重新上传 |
| 网络中断 | SSE 断开提示 | 自动重连，恢复进度 |
| 任务队列中断 | 任务恢复为 pending | 自动重新执行 |

### 5.4 用户引导

- **首次使用引导**：展示示例数据集，引导完成第一次分析
- **能力展示**：首次进入展示平台能力和示例问题
- **空状态设计**：会话为空时展示 3 个示例问题按钮，点击可填充输入框
- **错误修正建议**：SQL 执行失败时，AI 给出修正建议

### 5.5 会话管理

- **会话列表**：左侧展示，支持搜索、重命名、删除
- **会话摘要**：AI 自动生成一句话摘要作为标题
- **快捷模板**：常用分析流程保存为模板，一键复用

### 5.6 全局体验

- **明暗主题**：支持切换
- **通知**：长任务完成 / 失败时浏览器通知
- **图表配色**：可配置图表配色方案
- **语言**：仅支持中文

---

## 六、技术架构

### 6.1 技术选型

| 层级 | 技术 | 理由 |
|------|------|------|
| 前端框架 | Vite + React 18 + TypeScript | 轻量快速，类型安全 |
| UI 组件 | shadcn/ui (Base UI) + Tailwind CSS | 可控、现代、轻量 |
| 图表 | ECharts | 功能全、中文友好 |
| 代码编辑 | Monaco Editor | SQL / Python 编辑 |
| 状态管理 | Zustand | 轻量 |
| 后端框架 | FastAPI (Python 3.11) | 异步、类型安全、自动文档 |
| ORM | SQLAlchemy 2.0 | 成熟 |
| 主数据库 | PostgreSQL 16 | 业务数据 + 任务队列 + 日志 |
| 缓存 | Redis | 配置缓存 + Pub/Sub |
| 流式通信 | SSE (fetch + ReadableStream) | AI 流式输出天然适配 |
| AI 接入 | OpenAI 协议 + Anthropic 协议 | 双协议支持 |
| 数据分析 | Pandas | 处理查询结果 |
| 部署 | Docker Compose（应用层）+ 远程 PG / Redis / MinIO | 简单可靠，复用远程基础设施 |

### 6.2 架构图

```
┌─────────────────────────────────────────────┐
│              Frontend (React + Vite)        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Chat UI  │ │ Block    │ │ Chart    │   │
│  │          │ │ Renderer │ │ Renderer │   │
│  └──────────┘ └──────────┘ └──────────┘   │
│  ┌──────────────────────────────────────┐  │
│  │  SSE Client + API Client             │  │
│  └──────────────────────────────────────┘  │
└────────────────────┬────────────────────────┘
                     │ HTTP/SSE
┌────────────────────▼────────────────────────┐
│            FastAPI Backend                  │
│  ┌──────────────────────────────────────┐  │
│  │  API Routes                          │  │
│  │  /chat /datasource /export /task     │  │
│  │  /config /auth /sessions /logs       │  │
│  └──────────────┬───────────────────────┘  │
│  ┌──────────────▼───────────────────────┐  │
│  │  Services                            │  │
│  │  ChatService  DataService            │  │
│  │  ExportService  TaskService          │  │
│  │  ConfigService  SessionService       │  │
│  │  LogService                          │  │
│  └──────────────┬───────────────────────┘  │
│  ┌──────────────▼───────────────────────┐  │
│  │  Agent Engine                        │  │
│  │  Intent → SQL → Execute → Result     │  │
│  │         → Chart → Insights           │  │
│  └──────────────┬───────────────────────┘  │
│  ┌──────────────▼───────────────────────┐  │
│  │  LLM Provider (双协议适配层)          │  │
│  │  OpenAI Adapter / Anthropic Adapter  │  │
│  └──────────────┬───────────────────────┘  │
│  ┌──────────────▼───────────────────────┐  │
│  │  Task Queue (PostgreSQL SKIP LOCKED) │  │
│  └──────────────────────────────────────┘  │
└────────────────────┬────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
  ┌─────▼─────┐           ┌──────▼─────┐
  │ PostgreSQL │           │   Redis    │
  └───────────┘           └────────────┘
```

### 6.3 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 任务队列 | PostgreSQL | 减少依赖，事务性强，天然持久化 |
| 流式通信 | SSE | 单向流，AI 输出天然适配，实现简单 |
| 消息模型 | Block 数组 | AI 回复多类型混合，独立交互逻辑 |
| LLM 接入 | 双协议适配 | 灵活切换，避免供应商锁定 |
| 配置管理 | DB + Redis + Pub/Sub | 热更新，轻量可靠 |
| 架构风格 | 单体 + 模块化 | MVP 快速迭代，避免微服务复杂度 |
| 日志存储 | PostgreSQL 统一存储 | 简化架构，满足管理后台查看需求 |

---

## 七、后端功能设计

### 7.1 模块划分

```
backend/
├── api/                 # 路由层
├── services/            # 业务逻辑层
├── agents/              # AI Agent 引擎
├── llm/                 # LLM 双协议适配层
├── models/              # ORM 模型
├── schemas/             # Pydantic 模型
├── core/                # 配置、安全、依赖
├── tasks/               # 任务队列与 Worker
├── logging/             # 日志管理
└── utils/               # 工具函数
```

### 7.2 各模块职责

| 模块 | 职责 |
|------|------|
| `api/auth` | 登录、JWT 验证 |
| `api/sessions` | 会话 CRUD、消息列表 |
| `api/chat` | SSE 流式对话入口 |
| `api/datasources` | 数据源 CRUD、测试连接、预览 |
| `api/upload` | 附件上传、解析状态 |
| `api/export` | 数据 / 图表 / 报告导出 |
| `api/tasks` | 任务状态流、取消 |
| `api/config` | 系统配置读写 |
| `api/logs` | 日志查询、导出 |
| `api/templates` | 分析模板 CRUD |
| `services/ChatService` | 对话编排：意图识别→Agent 调用→Block 组装 |
| `services/DataSourceService` | 连接管理、Schema 提取与缓存 |
| `services/ExportService` | 多格式导出 |
| `services/TaskService` | 任务创建、状态机、进度推送 |
| `services/ConfigService` | 配置读写、缓存失效、热更新 |
| `services/LogService` | 日志写入、查询、清理 |
| `agents/` | SQL / Python / Viz 子 Agent |
| `llm/` | OpenAI / Anthropic 协议适配器 |

### 7.3 数据库表设计

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `users` | id, username, password_hash | 用户 |
| `sessions` | id, user_id, title, created_at | 会话 |
| `messages` | id, session_id, role, blocks(JSONB) | 消息（块数组） |
| `datasources` | id, user_id, name, type, config(JSONB) | 数据源 |
| `attachments` | id, session_id, file_path, parsed_schema, expires_at | 附件 |
| `tasks` | id, session_id, type, status, params, result, error | 任务 |
| `configs` | key, value, category | 系统配置 |
| `feedbacks` | id, message_id, rating, comment | 用户反馈 |
| `templates` | id, user_id, name, datasource_id, sql_text, chart_config | 分析模板 |
| `logs` | id, timestamp, level, category, message, context(JSONB) | 日志 |

### 7.4 任务队列（PostgreSQL 实现）

- 使用 `FOR UPDATE SKIP LOCKED` 实现并发消费
- 状态机：`pending → running → success/failed/cancelled`
- 超时自动失败
- 启动时恢复中断任务
- 取消通过状态标志 + 执行循环检查
- 任务表增加 `retry_count` 字段记录重试次数

### 7.5 配置热更新

- 读取：优先 Redis 缓存，未命中查 PostgreSQL 并回填
- 写入：更新 DB → 删除 Redis 缓存 → 发布 Pub/Sub
- 新配置对新会话生效，进行中会话沿用旧配置
- 配置变更写入审计日志

### 7.6 日志管理实现

- 使用 `structlog` 记录结构化日志
- 日志通过 `LogService` 异步写入数据库（批量写入优化）
- 日志级别和分类可配置
- 后台日志查询接口支持分页、过滤、排序
- 日志清理任务定期执行（每日），删除过期日志

### 7.7 安全设计

- JWT 认证（`python-jose`），有效期 24h
- 敏感数据加密存储（Fernet 对称加密）
- SQL 安全：禁止操作直接拦截，危险操作生成确认 Block
- 文件上传校验：扩展名白名单、MIME 检查、大小限制
- Python 沙箱执行：使用 Docker 容器隔离，设置 CPU/内存/超时限制
- API 限流：每个用户每分钟最多 10 次请求（可配置）

---

## 八、前端技术细节

### 8.1 组件架构（供参考）前端用 Vite 8 脚手架生成。

```
src/
├── components/
│   ├── chat/
│   │   ├── ChatContainer.tsx        # 对话主容器
│   │   ├── MessageList.tsx          # 消息列表
│   │   ├── MessageItem.tsx          # 单条消息
│   │   ├── blocks/                  # Block 渲染器
│   │   │   ├── TextBlock.tsx
│   │   │   ├── CodeBlock.tsx        # Monaco Editor
│   │   │   ├── TableBlock.tsx       # 虚拟表格
│   │   │   ├── ChartBlock.tsx       # ECharts
│   │   │   ├── ConfirmationBlock.tsx
│   │   │   ├── ProgressBlock.tsx
│   │   │   ├── SuggestionBlock.tsx
│   │   │   └── AttachmentBlock.tsx
│   │   ├── Composer.tsx             # 输入框
│   │   └── DataSourceTag.tsx        # 当前数据源标签
│   ├── datasource/
│   ├── config/
│   └── layout/
├── hooks/
│   ├── useSSE.ts
│   ├── useChat.ts
│   ├── useTaskProgress.ts
│   └── useConfig.ts
├── lib/
│   ├── sseClient.ts
│   ├── api.ts
│   └── blockFactory.ts
├── store/
│   ├── chatStore.ts
│   ├── dataSourceStore.ts
│   └── configStore.ts
└── types/
    ├── message.ts
    └── task.ts
```

### 8.2 Block 渲染器

- 注册表模式，通过 `type` 字段动态渲染
- CodeBlock：默认只读，点击编辑切换 Monaco Editor，运行触发自定义事件
- TableBlock：`@tanstack/react-virtual` 虚拟滚动，支持 10 万行
- ChartBlock：封装 ECharts，支持 PNG/SVG/PDF 导出
- 每种 Block 有独立状态管理和交互逻辑

### 8.3 SSE 客户端

- 使用 `fetch` + `ReadableStream` 实现，支持 POST
- 自动重连（最多 2 次）
- `AbortController` 管理连接取消

### 8.4 状态管理

- Zustand 按领域拆分：`chatStore`、`dataSourceStore`、`configStore`
- 消息列表使用不可变更新，避免全局重渲染

---

## 九、LLM 双协议支持与配置抽离

### 9.1 统一 Provider 抽象

定义统一的 `LLMProvider` 接口，屏蔽协议差异：

- `stream_chat(messages, **params)`：流式对话
- `chat(messages, **params)`：非流式对话
- `generate_sql(question, schema, history)`：生成 SQL
- `generate_python(question, data_info, history)`：生成 Python 代码
- `analyze_intent(question, context)`：意图识别

### 9.2 支持协议

| 协议 | 适用模型 | 流式格式 |
|------|---------|---------|
| OpenAI 协议 | OpenAI、Azure、vLLM、Ollama | `data: {choices: [...]}` |
| Anthropic 协议 | Claude 系列 | `event: content_block_delta` |

### 9.3 适配器要点

- 每种协议一个 Adapter 类，继承统一基类
- 消息格式统一为 OpenAI 风格，Anthropic Adapter 内部转换（`system` 字段分离）
- 流式响应统一为 `token` 字符串 yield 给上层
- 错误处理：非 200 响应、超时、流中断均抛出统一异常

### 9.4 配置抽离清单

**基础服务配置**（启动时加载，修改需重启）
- `DATABASE_URL`、`REDIS_URL`、`SECRET_KEY`、`ENABLE_AUTH`、`MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET`

**LLM 通用配置**（支持热更新）
- `LLM_PROVIDER`、`LLM_MODEL`、`LLM_TEMPERATURE`、`LLM_MAX_TOKENS`、`LLM_TIMEOUT`、`LLM_RETRY_COUNT`、`LLM_STREAM_ENABLED`

**OpenAI 协议配置**（支持热更新）
- `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_ORGANIZATION`

**Anthropic 协议配置**（支持热更新）
- `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_VERSION`

**系统行为配置**（支持热更新）
- `MAX_QUERY_ROWS`、`TASK_TIMEOUT`、`MAX_UPLOAD_SIZE_MB`、`SESSION_RETENTION_DAYS`、`SQL_SAFE_MODE`、`LOG_RETENTION_DAYS`

### 9.5 配置优先级

1. 动态配置（数据库 `configs` 表，运行时修改）
2. 静态配置（环境变量 / `.env` 文件）
3. 默认值（开发环境）

动态配置覆盖静态配置；进行中的会话在开始时加载配置快照，中途修改不影响。

---

## 十、部署架构

### 10.1 Docker Compose

| 服务 | 镜像 | 说明 |
|------|------|------|
| frontend | node:20-alpine | Vite + React，Nginx 服务静态文件 |
| backend | python:3.11-slim | FastAPI + Uvicorn |
| nginx | nginx:alpine | 反向代理 + 静态文件 |

PostgreSQL、Redis、MinIO 使用远程已部署实例（连接信息见根目录 `.env`），Compose 内不启动数据库与缓存服务。

### 10.2 Nginx 要点

- `/api/` 代理到 backend:8000
- SSE 路由关闭缓冲：`proxy_buffering off; proxy_cache off;`
- 上传大小限制：`client_max_body_size 20m;`
- 前端静态资源由 Nginx 直接服务

### 10.3 环境变量

- `OPENAI_API_KEY`：默认 LLM API Key（可选，可在后台配置）
- `ANTHROPIC_API_KEY`：Anthropic API Key（可选）
- `DATABASE_URL`：PostgreSQL 连接串
- `REDIS_URL`：Redis 连接串
- `SECRET_KEY`：JWT 签名密钥
- `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`：远程 MinIO 对象存储（附件存储）
- `ENCRYPTION_KEY`：敏感字段加密密钥（未设置时启动自动生成并持久化）
- `ENABLE_AUTH`：是否启用登录认证

---

## 十一、非功能需求

### 11.1 性能

| 指标 | 目标 |
|------|------|
| 简单查询响应 | < 5 秒 |
| AI 首 token 响应 | < 3 秒（受模型 API 影响） |
| 数据表格渲染 | 10 万行虚拟滚动不卡顿 |
| SSE 重连 | 网络中断后 3 秒内自动重连 |
| 任务队列消费延迟 | < 1 秒 |

### 11.2 可用性

- AI 响应失败自动重试 1 次
- 任务超时自动标记失败
- 服务重启后未完成任务恢复
- SSE 断开自动重连

### 11.3 安全

- 所有 API（除登录）需 JWT 认证
- 敏感数据加密存储
- SQL 操作分级管控
- 文件上传校验
- API 限流

### 11.4 日志

- 日志分类：系统、应用、AI、错误、审计
- 日志入库：PostgreSQL，保留 30 天（可配置）
- 日志查询：管理后台支持过滤和导出
- 关键日志（ERROR、CRITICAL、审计）高亮显示

---

## 十二、里程碑

| 阶段 | 周期 | 交付内容 |
|------|------|---------|
| M1：基础框架 | 1 周 | 项目搭建、DB 模型、认证、配置管理、日志框架、UI 框架 |
| M2：对话核心 | 1.5 周 | 多轮对话、流式响应、Block 渲染器、LLM 双协议 |
| M3：数据与查询 | 1.5 周 | 数据源管理、NL2SQL、SQL 编辑执行、附件上传 |
| M4：图表与导出 | 1 周 | 图表推荐、渲染、多格式导出 |
| M5：任务与优化 | 1 周 | 确认流程、任务管理、日志后台、性能调优、部署 |

**总周期：约 6 周**

---

## 十三、验收标准

| 场景 | 验收条件 |
|------|---------|
| 基础对话 | 用户提问 → 10 秒内获得完整回复 |
| SQL 查询 | 自然语言描述 → 生成 SQL → 可编辑 → 执行 → 展示表格 |
| 确认流程 | AI 识别危险操作 → 展示确认卡片 → 用户确认后执行 |
| 附件分析 | 上传 CSV → AI 识别结构 → 完成分析 → 输出图表 |
| 图表导出 | 生成图表 → 导出 PNG/PDF 正常 |
| 数据导出 | 查询结果 → 导出 CSV/Excel 正常 |
| 单数据源 | 选择数据源 → AI 正确使用该数据源分析 |
| 任务恢复 | 服务重启 → 未完成任务恢复为 pending |
| 配置热更新 | 后台修改 LLM 模型 → 新会话即时生效 |
| 双协议切换 | 切换 OpenAI/Anthropic → 对话功能正常 |
| 追问建议 | AI 回复后展示建议按钮 → 点击可继续分析 |
| 错误处理 | SQL 语法错误 → 展示错误 + 修正建议 |
| SQL 编辑 | 编辑 SQL → 重新执行 → 结果回填对话流 |
| 日志管理 | 后台可查看各类日志，支持过滤和导出 |


**补充信息**

所有接口只用 GET 和 POST, 复杂查询直接用 POST。

项目初始化能用脚手架就用脚手架，尽量节省 Token.

数据源与附件优先级：当存在多个数据源（主数据源+附件）时，AI 应优先使用用户明确指定的数据源；若用户未指定，优先使用主数据源；附件仅作为辅助数据，除非用户要求使用附件。

数据源管理页面：在左侧导航增加“数据源”入口，展示所有已配置数据源，支持新建、编辑、删除、测试连接。

未选择数据源：允许通用对话，但涉及数据操作时提示“请先选择数据源或上传文件”。

Excel 多 sheet：MVP 默认使用第一个 sheet，并在附件解析结果中显示 sheet 名。

导出范围：Markdown 导出包含所有文本、代码、表格（转为 Markdown 表格）和图表（作为图片嵌入）；PDF 通过浏览器打印当前对话内容。

任务取消：用户点击取消后，后端设置任务状态为 cancelled，前端 progress block 显示“已取消”，并保留重试按钮。

SSE 重连：前端重连后，先调用任务状态查询接口获取当前状态，然后继续订阅 SSE。

管理后台权限：MVP 所有登录用户均可访问配置和日志（单用户为主）；若后续多用户，需增加管理员角色。

默认账号：首次初始化时创建默认管理员（用户名 `admin`，初始密码 `Admin@12345`，首次登录提示修改密码）。

模板：模板保存为可复用的分析配置（包含数据源、SQL、图表配置），在输入框提供“使用模板”入口。收藏与分享功能不在 MVP 范围内。

Token 消耗：在每条 AI 消息底部展示“消耗约 X tokens”。

配置项范围：定义温度 0-1，最大 Token 100-10000，日志级别 DEBUG/INFO/WARNING/ERROR/CRITICAL。

任务并发：系统最多同时运行 3 个任务（可配置），超出排队。

附件预览：默认展示前 50 行，可滚动查看更多。
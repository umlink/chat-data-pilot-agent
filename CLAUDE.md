# CLAUDE.md — DataPilotAgent 工程规范

本文件是仓库唯一权威开发规范。所有代码改动必须遵守；有冲突时以 docs/ 下的契约文档为准（见第 3 节）。
里程碑背景：AI 自然语言数据分析 MVP（FastAPI + React），模块按 M1–M5 演进，每模块开发完必须自测连通性后才能进入下一模块。

---

## 1. 项目结构与分层

```
（仓库根目录）
├── docs/              产品与契约文档（PRD / 技术方案 / Block协议 / UI规范）
├── backend/           后端（FastAPI）
│   ├── app/
│   │   ├── api/       HTTP 层：路由薄、只做参数校验与响应包装，逻辑在 service
│   │   ├── services/  业务逻辑层：所有可测逻辑在此（Chat / Config / Task / Data / Storage / Log / Export）
│   │   ├── models/    SQLAlchemy 2.0 ORM 模型（单一事实源的表结构）
│   │   ├── schemas/   Pydantic v2 请求/响应模型（含 API 层 DTO）
│   │   ├── core/      基础：config / database / security / (redis)
│   │   ├── llm/       LLM 适配器（OpenAI / Anthropic 双协议）
│   │   ├── agents/    Agent 工具集（run_sql / run_python / create_chart / request_confirmation）
│   │   ├── tasks/     任务队列（PostgreSQL SKIP LOCKED）与 Worker
│   │   └── utils/     纯函数工具
│   └── alembic/       数据库迁移（生产一律走迁移，禁止依赖 create_all）
└── frontend/          前端（React 19 + Vite + Tailwind v4）
    └── src/
        ├── routers/   路由表（react-router，由 root radial 统一出口）
        ├── pages/     路由级页面（页面 + 私有子组件按路由目录组织）
        ├── components/ 跨页面共享组件（ui / layout / common / chat 共享渲染等）
        ├── store/     zustand 状态
        ├── hooks/     跨页面共享 hooks（页面私有 hooks 随页放 pages/<route>/）
        ├── lib/       api 客户端 / SSE 客户端
        └── types/     前后端共享契约类型（message.ts）
```

**分层规则（强制）**：
- `api/` 不得包含业务逻辑，只做：解析入参 → 调 service → 组装 `ApiResponse`。异常一律抛 `HTTPException`（由全局 handler 转为信封）。
- service 不得引用 request/response 对象；它的依赖通过参数或工厂注入（DB 会话、Redis、LLM Provider）。
- model 不得引入 Pydantic/API 逻辑；`schemas` 不得引入 ORM 副作用。
- 跨层引用方向必须是 `api → service → model/schema`，禁止反向。

---

## 2. 通用开发纪律

1. **逐模块自测**：每实现一个功能模块，必须启动后端并实测对应 API 全链路（登录→业务→状态），输出自测记录，连通后方可进入下一模块。自测用 root `.env` 的远程基础设施。自测记录随提交消息与对话留存即可，**禁止创建/维护独立会话记录文件**（`sessiom.md` 已于 2026-08-26 废弃删除，不得再新建类似文件，避免仓库杂项堆积）。
2. **阻塞性决策必须问用户**：涉及跨模块协议变更、数据库结构取舍、安全边界、对外（价格/部署）动作必须确认，禁止擅自拍板。
3. **契约优先**：凡已写入 docs/ 的接口与数据类型，前后端实现必须与之逐字对齐；改契约必须先改文档并同步两端。

---

## 3. 契约文档（实现时的唯一准绳）

| 文档 | 领域 |
|------|------|
| `docs/需求PRD.md` | 功能范围与验收口径（v1.2） |
| `docs/技术方案设计.md` | 架构、DDL、API 一览、任务队列、安全设计 |
| `docs/Block与协议规范.md` | **Block 结构 / SSE 事件载荷 / LLM 工具协议 / 附件引擎 / 状态流转** |
| `docs/UI设计规范.md` | 设计 token、组件规范、Block 渲染标准、9 条开发规则 |

冲突裁决顺序：`Block与协议规范.md` > `技术方案设计.md` > `需求PRD.md`。

---

## 4. Python 后端规范（严格）

### 4.1 语言与风格
- Python 3.11+，全部使用新式类型注解（`X | None`）；公开函数与类必须有类型注解。
- 风格对齐 Black（单行 ≤ 100 字符）与 isort（标准库 → 三方 → 本地，绝对导入，禁用通配符）。
- 命名：文件/函数/变量 `snake_case`，类 `PascalCase`，常量 `UPPER_SNAKE`，private 加 `_` 前缀。
- 禁止 `except: pass` 吞异常：必须捕获具体异常；确实可忽略的场景必须留注释说明原因（如“基础设施不可用降级启动”）。

### 4.2 异步与阻塞
- 全程 async（FastAPI + SQLAlchemy async + asyncpg + redis.asyncio）。禁止在事件循环内跑同步重 CPU 任务。
- pandas / openpyxl / 大规模文件解析属于 CPU/IO 密集，一律放进任务队列 Worker；Worker 内用 `asyncio.to_thread` 包同步解析，避免阻塞其他协程。
- 请求级 DB 会话通过 `get_db` 注入；service 若需自建会话，用 `SessionFactory()`，并紧随 `async with` 关闭，禁止跨函数保存会话。

### 4.3 SQLAlchemy 2.0（ORM 规则）
- 只用新 API：`select() / update() / delete()`，禁止 `session.query()`。
- 模型列声明用 `Mapped[X] = mapped_column(...)`；JSON 用 `JSONB`；主键 UUID 用 `server_default=text("gen_random_uuid()")`；时间用 `server_default=func.now()`。
- 关系必须成对设置 `back_populates`；级联删除明确声明（`cascade="all, delete-orphan"` 或 DB 级 `ON DELETE`）。
- 查询一律带 `where` 归属过滤（`user_id == current_user.id`），杜绝跨用户数据泄露。
- schema 变更：写 Alembic migration，禁止在已交付环境 `drop`/`create_all` 覆盖数据。

### 4.4 Pydantic v2
- 用 `BaseModel` + `ConfigDict(from_attributes=True)`（ORM→模型）；不用 v1 的 `validator/dict/parse_obj`。
- 校验用 `field_validator / model_validator`；序列化用 `model_dump(mode="json")`。
- 响应 DTO 与 `schemas/common.py` 的 `ApiResponse[T]` / Block 契约保持一致，类型要精确（`list[Block]` 而非 `list`）。

### 4.5 错误与响应约定
- 统一信封：成功 `{"code": 0, "data": ..., "message": "ok"}`。
- 业务错误：抛 `HTTPException(status_code=4xx, detail=中文可读信息)`，由**全局异常处理器**转换为 `{"code": <http_status>, "data": null, "message": detail}`（注册于 main.py，包括 `RequestValidationError` → `{"code": 422, "message": "参数错误", "detail": [...]}`）。
- 禁止在信封外直接返回裸 dict / 裸列表（除 `/api/health` 等基础设施端点，需在注释说明）。
- Token 失效统一 401；资源不存在/非本人统一 404；参数不合法统一 400/422——前端 `ApiError` 依赖 `code` 字段展示 message。

### 4.6 安全（不可妥协）
- 认证：JWT（`Authorization: Bearer`），密码 bcrypt，登录勿泄露账号是否存在（统一“用户名或密码错误”）。
- 敏感字段（config 的 api_key、datasource 的 password）：入库一律 `encrypt_secret`（`enc:` 前缀 Fernet）；对外返回一律掩码 `******`；更新时用 `upsert_secret` 保留掩码与旧密文。
- 严禁将 `.env`、加密密钥、`enc:` 密文写入日志、注释、API 响应或提交记录。
- 越权防护：任何按 id 取实体的操作都必须校验归属（当前用户）。
- CORS 白名单走 `settings.CORS_ORIGINS`，不随手加 `*`；登录接口限流（每 IP 每分钟 5 次）。

### 4.7 日志（统一 structlog → LogService 入库）
- 日志分类固定五类：`system / application / ai / error / audit`；级别含 `CRITICAL`。
- 断言：`ai` 类日志必须带 `model`、`tokens`、`latency_ms`；`audit` 类必须带 `user`、`resource`、`action`。
- 请求级 `request_id` 经 `structlog.contextvars` 贯穿；不把异常堆栈塞进 message，写入 `context`。

### 4.8 接口/模块约束
- 路由前缀与模块一致；动作类端点统一 `POST /xxx/update|delete|test|...`（见技术方案 2.3），禁止 REST 秀（DELETE/PUT 不用于业务动作）。
- `POST /api/chat/stream` 与 `GET /api/tasks/{id}/stream` 返回 `text/event-stream`：SSE 事件严格按 `docs/Block与协议规范.md` 第 3 章（token/block_start/block_update/block_end/task_status/error/done，`id` 单调，15s 心跳，`block_update` 用 JSON Merge Patch，`done`/`error` 后关闭流）。
- 任务队列用 PostgreSQL `FOR UPDATE SKIP LOCKED`，状态机 `pending → running → success/failed/cancelled`；超时恢复与取消检查在 Worker 内落实。

---

## 5. 前端规范（严格）

### 5.1 工程
- TS `strict`；路径别名 `@/` → `src/`（无 baseUrl，paths 相对 tsconfig）。类型错误不得绕过（禁止 `any` 泛滥；Block.content 用记录类型 + 按 type 断言）。
- 包管理 `pnpm`；提交前必须过三关：`pnpm exec tsc -b`（无报错）、`pnpm exec oxlint src`（CLEAN）、`pnpm run build`（成功）。
- oxlint 配置（`.oxlintrc.json`）：`rules-of-hooks` 为 error；`only-export-components` 为 warn；**`set-state-in-effect` / `incompatible-library` 已显式关闭**——二者为 React Compiler 时代启发式规则，对「弹窗打开时经 effect 初始化表单」「effect 内异步取数先置 loading」「@tanstack/react-virtual 的 useVirtualizer」等仓库内标准且正确的模式误报，关闭以保持告警高信噪比（0 errors 底线不变）。新增规则/恢复需说明理由。
- 不要降级依赖锁版本；新增依赖需说明理由。

### 5.2 结构与组件
- 组件一律具名导出（`export function X`），禁止默认导出组件；props 用 `interface Props`。
- 目录：
  - 页面按路由级收在 `pages/<route>/`，页面入口由 `routers/` 唯一引用，命名与路由/领域概念一致（如 `pages/board/BoardPage.tsx`、`pages/datasources/DataSourcePage.tsx`、`pages/chat/ChatArea.tsx`、`pages/notifications/NotificationChannelsPage.tsx`）；页面私有子组件与私有 hooks 随页同目录。
  - `components/` 只放跨页面共享组件（`ui/` shadcn 原语、`layout/` 外壳、`common/` 通用含 `MaskedInput`、`chat/` 的共享渲染 `ChartBlock/TableBlock/SqlQueryDialog/PushToChannelDialog/SqlHistoryDialog`）。
  - 路由表只放在 `routers/`；禁止 `components/` 反向引用 `@/pages/...`。
- 组件保持短小（< ~200 行）；跨页面共享逻辑抽 `hooks/`（如 `useChat` 供 AppShell/Sidebar 共用），页面私有 hooks 随页放 `pages/<route>/`；跨页面共享状态进 `store/`（zustand）。
- 列表/大表用虚拟化（@tanstack/react-virtual）与 memo，禁止整表重渲染。

### 5.3 样式（Tailwind v4）
- 全部使用语义 token，**禁止在组件里写裸色值/裸字号**（如 `#fff`、`text-[15px]` 仅在极少数一次性场景，需注释理由）。
- 原语类（`.btn / .badge / .status-dot` 等）统一收在 `index.css` 的 `@layer components`；`@apply` 不得用于自定义动画类（v4 限制）。
- 深色模式用 `@custom-variant dark` + 语义变量；图表色板等设计 token 见 `docs/UI设计规范.md`。

### 5.4 与后端契约的落地
- 请求经 `lib/api.ts`（信封解析、自动带 token、统一抛 `ApiError`）；流式经 `lib/sseClient.ts` 的 `streamSSE`。
- `src/types/message.ts` 是契约类型唯一来源，**与 `backend/app/schemas/common.py` 保持镜像**，改一端必须同步另一端。
- Block 渲染：`type` 决定 content 形状，访问时按 type 断言字段；`block_update` 只做浅合并 patch，避免整树重建。
- 消息流：token 缓冲合并（50ms / 10 token）后批量 setState（见 Block 契约 6.3）；SSE 按 sessionId 隔离——同会话发新消息 abort 旧流防竞态，切换会话后台流继续（切回可见已完成结果），登出/卸载取消全部（`cancelAllStreams`）。

### 5.5 质量底线
- 无 `console.log` 残留（调试用 `console.debug` 提交前删除）；错误路径必须有用户可读的中文提示。
- UI 组件 Accessibility：按钮带 `aria-label`，可点击元素有键盘可达路径。

---

## 6. 里程碑（M1–M5）与当前进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| 骨架 | 后端骨架 + 前端脚手架 + 路由 | ✅（除 auth 外后端为 TODO 占位） |
| M1 | 会话 / 配置 / 任务队列 + Worker | ⏳ 当前：任务 #4 启动验证 → #5 会话 → #6 配置 → #7 队列 |
| M2 | LLM 适配器 / ChatService+SSE / Agent 工具 | 未开始 |
| M3 | 数据源 CRUD+连接 / 附件引擎 | 未开始 |
| M4 | 导出 / 模板 | 未开始 |
| M5 | 日志查询与导出 | 未开始 |
| 收尾 | 全链路冒烟 | 未开始 |

开发顺序按上表严格推进；每个模块完成即按第 2 节自测。

---

## 7. 环境与运行

- 基础设施全部远程（PostgreSQL / Redis / MinIO，见根目录 `.env`，勿提交、勿外泄）。
- 表结构由 Alembic 管理（初始迁移 `alembic/versions/*_initial_schema.py` 已建库并 `stamp` 到 head）。
  - 首次/升级库：`cd backend && ./venv/bin/alembic upgrade head`（生产部署前必须执行，禁止依赖 `create_all`）。
  - 校验漂移：`./venv/bin/alembic check`（应输出 `No new upgrade operations detected.`）。
  - schema 变更：改 `app/models/` → `./venv/bin/alembic revision --autogenerate -m "..."` → 人工核对 → `upgrade head`。
- 后端启动：`cd backend && ./venv/bin/uvicorn app.main:app --reload --port 8010`；首次需 `python3 -m venv venv && ./venv/bin/pip install -r requirements.txt`。
- 前端启动：`cd frontend && pnpm dev`（Vite 默认 5173，CORS 已含）。
- 自测命令速查（后端在 8010 起时）：
  ```bash
  curl -s localhost:8010/api/health
  curl -s -X POST localhost:8010/api/auth/login -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"Admin@12345"}'
  ```
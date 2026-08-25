# DataPilotAgent

AI 驱动的智能数据分析平台 MVP。自然语言对话完成数据查询、分析、可视化与洞察提取。

文档：
- `docs/需求PRD.md` — 产品需求（v1.2）
- `docs/技术方案设计.md` — 技术方案
- `docs/Block与协议规范.md` — 前后端开发契约（Block / SSE / LLM 工具协议）

## 环境

基础设施（PostgreSQL / Redis / MinIO）使用远程实例，连接信息在根目录 `.env`（已就绪）。

```
PG_HOST / PG_PORT / PG_DB / PG_USER / PG_PASSWORD
REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY
```

Windows 下 `export $(xargs < .env)` 用法参考；macOS/Linux：`set -a; source .env; set +a`。

## 本地开发

### 后端（FastAPI）

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

- 启动时自动建表 + 初始化（默认管理员 `admin / Admin@12345`、默认配置、MinIO bucket）
- 接口文档 http://localhost:8000/docs

### 前端（Vite + React）

```bash
cd frontend
npm install
npm run dev
```

## Docker Compose 部署（应用层）

```bash
docker compose up -d --build
```

Nginx 80 端口：前端静态资源 + `/api/` 反向代理（SSE 已关闭缓冲）。

> 生产必须设置 `SECRET_KEY` 并显式提供 `ENCRYPTION_KEY`（详见技术方案 5.1 说明）。
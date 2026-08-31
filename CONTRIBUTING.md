# Contributing

欢迎 Issue 与 PR。在提交代码前，请阅读以下约定。

## 开发环境

- Python 3.11+ · Node.js 20+ · pnpm 9+
- 全套基础设施（PostgreSQL / Redis / MinIO）可用 Docker 一键拉起：

  ```bash
  cp .env.example .env
  docker compose -f docker-compose.infra.yml up -d
  cd backend && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
  cd frontend && pnpm install
  ```

- 首次/升级库：`cd backend && ./venv/bin/alembic upgrade head`

## 约定

- **契约优先**：`docs/` 下的 PRD / 技术方案 / Block 协议 / UI 规范是实现准绳；改契约必须先改文档并同步前后端。
- 后端：FastAPI + async + SQLAlchemy 2.0；分层 `api → service → model/schema`，禁止跨层反向与裸字典响应；敏感字段加密、资源按归属校验。
- 前端：React 19 + TS strict + Tailwind v4；语义 token，禁止组件内裸色值；具名导出组件；列表用虚拟滚动。
- 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` ...）。

## 提交前必须通过

```bash
# 前端三关（类型 / lint / 构建）
cd frontend && pnpm exec tsc -b && pnpm exec oxlint src && pnpm run build
```

## 流程

1. Fork 并基于 `main` 新建分支。
2. 完成后跑上面的三关，并自行验证对应 API / 功能连通性。
3. 提交并开 PR，说明改动动机、验证方式与契约变动（如有）。
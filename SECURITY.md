# Security Policy

## Reporting a Vulnerability

如果发现安全漏洞（提权、越权访问其他用户数据、Sensitive 字段泄露、SQL 注入、SSRF、认证绕过等），请**不要**在公开的 Issue 中披露。

请通过以下任一方式私密报告：

- 邮件：`maintainers@example.com`（请替换为实际维护者邮箱）
- 或仓库的 **Private vulnerability reporting**（GitHub → Security → Report a vulnerability）

请提供尽可能多的复现信息：受影响的版本、攻击路径、最小复现步骤与影响说明。我们会尽快响应（一般 72 小时内确认，修复后发布通知）。

## Supported Versions

| 分支 | 支持状态 |
|---|---|
| `main` | 活跃开发 / 安全修复 |

## 安全基线

本项目已内置以下防护（详见 `docs/技术方案设计.md`）：

- JWT（Bearer）+ bcrypt 密码哈希；登录接口按 IP 限流
- 数据源密码、LLM API Key 等敏感字段 Fernet 加密（`enc:` 前缀）入库，对外一律掩码
- 所有按 ID 的资源访问强制校验归属，杜绝跨用户越权
- SQL 执行只读约束 + Python 沙箱（RestrictedPython），危险操作需人工确认
- CORS 白名单走 `CORS_ORIGINS`，禁止 `*`

部署前务必：更换 `SECRET_KEY`、显式提供 `ENCRYPTION_KEY`，并**不要**将 `.env` / 加密密钥提交或外泄。
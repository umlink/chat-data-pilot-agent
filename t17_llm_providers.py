"""/api/llm/providers 全链路验证 + get_llm_config 优先 provider 表。临时脚本，测完即删。

用法（backend 目录）：./venv/bin/python ../t17_llm_providers.py
"""
import asyncio
import sys

import httpx

BASE = "http://localhost:8010"
results: list[tuple[str, bool, str]] = []
_fail = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _fail
    results.append((name, bool(cond), detail))
    if not cond:
        _fail += 1
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


async def unit_get_llm_config() -> None:
    """provider 表有默认行时，get_llm_config 应返回该 provider 的配置。"""
    from app.services.config_service import ConfigService

    cfg = await ConfigService().get_llm_config()
    check("单测: get_llm_config 返回 provider 表默认行", cfg.get("provider") in ("openai", "anthropic") and "api_key" in cfg, str(cfg)[:120])


def main() -> None:
    c = httpx.Client(base_url=BASE, timeout=30)
    r = c.post("/api/auth/login", json={"username": "admin", "password": "Admin@12345"})
    check("登录", r.status_code == 200, r.text[:120])
    H = {"Authorization": f"Bearer {r.json()['data']['token']}"}

    # 1) 空列表
    r = c.get("/api/llm/providers", headers=H)
    check("初始列表为空", r.status_code == 200 and r.json()["data"] == [], r.text[:200])

    # 2) 创建第一个（自动默认；api_key 加密出参掩码）
    r = c.post("/api/llm/providers", headers=H, json={
        "name": "DeepSeek", "type": "openai", "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test-123", "models": ["deepseek-chat", "deepseek-reasoner"], "default_model": "deepseek-chat",
    })
    check("创建首个(自动默认)", r.status_code == 200 and r.json()["data"]["is_default"] is True, r.text[:200])
    d = r.json()["data"]
    check("出参 api_key 掩码", d["api_key"] == "******", d["api_key"])
    pid1 = d["id"]

    # 3) 创建第二个（非默认）
    r = c.post("/api/llm/providers", headers=H, json={
        "name": "Claude", "type": "anthropic", "base_url": "https://api.anthropic.com",
        "api_key": "sk-ant-456", "models": ["claude-3-5-sonnet"], "default_model": "claude-3-5-sonnet",
    })
    check("创建第二个(非默认)", r.status_code == 200 and r.json()["data"]["is_default"] is False, r.text[:200])
    pid2 = r.json()["data"]["id"]

    # 4) 列表（默认优先）
    r = c.get("/api/llm/providers", headers=H)
    rows = r.json()["data"]
    check("列表含 2 条且默认在前", r.status_code == 200 and len(rows) == 2 and rows[0]["id"] == pid1, str([x["id"] for x in rows]))

    # 5) set-default 切换
    r = c.post(f"/api/llm/providers/{pid2}/set-default", headers=H)
    check("set-default", r.status_code == 200 and r.json()["data"]["is_default"] is True, r.text[:120])
    r = c.get("/api/llm/providers", headers=H)
    check("切换后默认在前", r.json()["data"][0]["id"] == pid2, str([x["id"] for x in r.json()["data"]]))

    # 6) update：掩码 api_key 保留旧密文；改模型
    r = c.post("/api/llm/providers/update", headers=H, json={
        "id": pid2, "api_key": "******", "models": ["claude-3-5-sonnet", "claude-3-7-sonnet"],
    })
    check("update(掩码保留+改模型)", r.status_code == 200 and len(r.json()["data"]["models"]) == 2, r.text[:200])

    # 7) test：有 key 时返回 ok=False 或 ok=True（网络可达性不定，仅校验结构）
    r = c.post(f"/api/llm/providers/{pid1}/test", headers=H)
    body = r.json()
    check("test 返回结构", r.status_code == 200 and "ok" in body["data"] and ("error" in body["data"] or "model" in body["data"]), r.text[:200])

    # 8) 非法 type 400
    r = c.post("/api/llm/providers", headers=H, json={"name": "x", "type": "gpt"})
    check("非法 type 400", r.status_code == 400, r.text[:120])

    # 9) 未认证 401
    check("未认证 401", c.get("/api/llm/providers").status_code == 401)

    # 10) get_llm_config 单测（默认 provider 为 pid2/anthropic）
    asyncio.run(unit_get_llm_config())

    # 11) 清理：删除默认 pid2 → 自动提升 pid1；再删 pid1 → 空表（回退旧 configs 键）
    r = c.post("/api/llm/providers/delete", headers=H, json={"id": pid2})
    check("删除默认自动提升", r.status_code == 200, r.text[:120])
    r = c.get("/api/llm/providers", headers=H)
    check("删除后 pid1 提升为默认", len(r.json()["data"]) == 1 and r.json()["data"][0]["is_default"] is True, r.text[:200])
    r = c.post("/api/llm/providers/delete", headers=H, json={"id": pid1})
    check("删除最后一个", r.status_code == 200, r.text[:120])
    r = c.get("/api/llm/providers", headers=H)
    check("清理后列表为空", r.json()["data"] == [], r.text[:200])

    print("\n========== 汇总 ==========")
    passed = len(results) - _fail
    print(f"PASS {passed}/{len(results)}，FAIL {_fail}")
    if _fail:
        for name, ok, detail in results:
            if not ok:
                print(f"  FAILED: {name}  {detail}")
        sys.exit(1)


if __name__ == "__main__":
    main()

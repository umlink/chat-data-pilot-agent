"""受限 Python 沙箱（Agent 工具 run_python 的后端）。

契约见 docs/技术方案设计.md 2.8：
- RestrictedPython 受限编译 + 子进程隔离执行；
- 子进程内 `resource.setrlimit` 限制 CPU 10s / 内存 256MB，外层 `wait_for` 30s 兜底；
- 仅允许导入白名单模块（pandas / numpy / scipy.stats / datetime / json / math）；
- 代码以 DataFrame（df1/df2…）形式注入，调用 `return_table(df)` 捕获生成的新表。
"""
import asyncio
import json
import logging
import sys
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("datapilot.sandbox")

_PAYLOAD_DIR = Path("data/tmp")
_CPU_SECONDS = 10
_RAM_BYTES = 256 * 1024 * 1024
_TIMEOUT_SECONDS = 30
_IMPORT_WHITELIST = {"pandas", "numpy", "scipy", "datetime", "json", "math"}

_RUNNER = r'''"""沙箱 runner：由主进程以 subprocess 方式拉起，argv[1]=payload, argv[2]=result。"""
import json
import math
import resource
import sys
import uuid as _uuid
import traceback

for _res, _lim in ((resource.RLIMIT_CPU, (10, 10)),
                   (resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))):
    try:
        resource.setrlimit(_res, _lim)
    except ValueError as _exc:
        # macOS 上 RLIMIT_AS 软限常低于解释器自身占用，跳过该维度的硬限制（Linux 生产生效）
        print(f"[sandbox] 资源限制不可用，跳过 {_res}: {_exc}", file=sys.stderr)

import datetime  # noqa: E402,F401  白名单
import json as _json  # noqa: E402,F401
import math  # noqa: E402,F401
import numpy as np  # noqa: E402,F401
import pandas as pd  # noqa: E402,F401

from RestrictedPython import compile_restricted_exec, safe_globals
from RestrictedPython.Eval import (
    default_guarded_getattr,
    default_guarded_getitem,
    default_guarded_getiter,
)
from RestrictedPython.Guards import (
    guarded_iter_unpack_sequence,
    guarded_unpack_sequence,
    full_write_guard,
)
from RestrictedPython.PrintCollector import PrintCollector

payload_path, result_path = sys.argv[1], sys.argv[2]
with open(payload_path, encoding="utf-8") as f:
    payload = _json.load(f)
code = payload["code"]
inserts = payload["inserts"]  # [{"name": "df1", "columns": [...], "rows": [...], "block_id": ...}]

result = {"blocks": [], "rerun": False}


def _clean(df):
    """DataFrame → {columns, rows, total}，NaN/NaT/None 统一转为 JSON null。"""
    df = df.reset_index(drop=True)
    columns = [str(c) for c in df.columns]
    records = df.to_dict("records") if len(df) else []

    def _norm(v):
        try:
            if v is None:
                return None
            if isinstance(v, float) and math.isnan(v):
                return None
            if isinstance(v, (_uuid.UUID, datetime.datetime, datetime.date)):
                return str(v)
            if hasattr(v, "item"):  # numpy 标量
                v = v.item()
                if isinstance(v, float) and math.isnan(v):
                    return None
            return v
        except (TypeError, ValueError):
            return str(v)

    rows = [{c: _norm(r.get(c)) for c in columns} for r in records]
    return {"columns": columns, "rows": rows, "total": len(rows)}


class _ReturnTable(Exception):
    def __init__(self, block_id):
        self.block_id = block_id


def return_table(df):
    """暴露给用户代码：把 DataFrame 注册为新 table block 并结束本轮执行。"""
    block_id = str(_uuid.uuid4())
    result["blocks"].append({"id": block_id, "table": _clean(df)})
    raise _ReturnTable(block_id)


result_meta = {"table_id": None}

glb = safe_globals.copy()
glb.update({
    "_getattr_": default_guarded_getattr,
    "_getitem_": default_guarded_getitem,
    "_getiter_": default_guarded_getiter,
    "_unpack_sequence_": guarded_unpack_sequence,
    "_iter_unpack_sequence_": guarded_iter_unpack_sequence,
    "_write_": full_write_guard,
})


def _restricted_import(name, *args, **kwargs):
    _whitelist = {"pandas", "numpy", "scipy", "datetime", "json", "math"}
    root = name.split(".")[0]
    if root not in _whitelist:
        raise ImportError(f"模块 {name} 不在白名单（允许: {', '.join(sorted(_whitelist))}）")
    return __import__(name, *args, **kwargs)


glb["__name__"] = "__main__"
glb["__builtins__"] = dict(safe_globals["__builtins__"])
glb["__builtins__"]["__import__"] = _restricted_import
# v8.5 的 print 变换为 `_print = _print_(_getattr_)`，故 _print_ 需为类；
# 收集到的输出经 exec 后的 _print 实例获取
glb["_print_"] = PrintCollector
glb["return_table"] = return_table
for ins in inserts:
    df = pd.DataFrame(ins["rows"], columns=ins.get("columns") or None)
    glb[ins["name"]] = df

try:
    compiled = compile_restricted_exec(code, filename="<sandbox>")
    if compiled.errors:
        raise Exception("；".join(compiled.errors))
    result_meta["ok"] = True
    try:
        exec(compiled.code, glb)  # noqa: S102  受限字节码
    except _ReturnTable as done:
        result_meta["table_id"] = done.block_id
    _print = glb.get("_print")
    if _print is not None:
        collected = _print()
        if collected:
            print(collected, end="")
except Exception as exc:  # noqa: BLE001
    result_meta["ok"] = False
    result_meta["error"] = "".join(
        traceback.format_exception_only(type(exc), exc)
    ).strip()
    # 用户代码内抛异常时也要产出已捕获的表
    if result["blocks"]:
        result_meta["ok"] = True
        result_meta["table_id"] = result["blocks"][-1]["id"]

with open(result_path, "w", encoding="utf-8") as f:
    _json.dump({**result_meta, "blocks": result["blocks"]}, f, ensure_ascii=False, default=str)
'''


def _prepare_payload(code: str, inserts: list[dict[str, Any]]) -> tuple[Path, Path, Path]:
    """写入 payload / runner，返回 (payload_path, runner_path, result_path)。"""
    _PAYLOAD_DIR.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    payload_path = _PAYLOAD_DIR / f"sandbox_{token}.json"
    runner_path = _PAYLOAD_DIR / "sandbox_runner.py"
    result_path = _PAYLOAD_DIR / f"sandbox_result_{token}.json"
    payload_path.write_text(
        json.dumps({"code": code, "inserts": inserts}, ensure_ascii=False), encoding="utf-8"
    )
    if not runner_path.exists():
        runner_path.write_text(_RUNNER, encoding="utf-8")
    return payload_path, runner_path, result_path


async def run_sandbox(code: str, inserts: list[dict[str, Any]]) -> dict[str, Any]:
    """执行受限代码。

    inserts: [{"name": "df1", "columns": [...], "rows": [...], "block_id": ...}]
    返回 {"text", "result_block_id"|None, "result_blocks": {...}, "error"|None, "duration_ms"}。
    """
    payload_path, runner_path, result_path = _prepare_payload(code, inserts)
    started = time.perf_counter()
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(runner_path),
            str(payload_path),
            str(result_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return {
                "error": f"代码执行超过 {_TIMEOUT_SECONDS}s，已终止",
                "text": "", "duration_ms": int((time.perf_counter() - started) * 1000),
            }
        text = stdout_b.decode("utf-8", "replace")[:4000]
        stderr = stderr_b.decode("utf-8", "replace")[-2000:]
        meta: dict[str, Any] = {}
        blocks: list[dict] = []
        if result_path.exists():
            try:
                meta = json.loads(result_path.read_text(encoding="utf-8"))
                blocks = meta.get("blocks", [])
            except Exception:
                pass
            result_path.unlink(missing_ok=True)
        duration_ms = int((time.perf_counter() - started) * 1000)
        if meta.get("ok") is False:
            return {
                "error": (meta.get("error") or stderr or "沙箱执行失败").strip()[:1000],
                "text": text, "duration_ms": duration_ms,
            }
        return {
            "text": text,
            "result_table_id": meta.get("table_id"),
            "result_blocks": {b["id"]: b["table"] for b in blocks},
            "duration_ms": duration_ms,
        }
    except Exception as exc:  # 沙箱基础设施故障
        logger.exception("沙箱拉起失败")
        return {"error": f"沙箱启动失败：{exc}", "text": "", "duration_ms": 0}
    finally:
        for p in (payload_path,):
            p.unlink(missing_ok=True)
"""DataSourceService：连接管理、Schema 提取与缓存、SQL 执行路由。
TODO(M1/M3)：多类型数据源连接、schema 缓存、临时 SQLite 附件引擎路由。
"""


class DataService:
    async def test_connection(self, ds_type: str, config: dict) -> bool:
        raise NotImplementedError("M3")

    async def preview(self, ds_id: str, limit: int = 50) -> dict:
        raise NotImplementedError("M3")

    async def get_schema(self, ds_id: str) -> dict:
        raise NotImplementedError("M3")
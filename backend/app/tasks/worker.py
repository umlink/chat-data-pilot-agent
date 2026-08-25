"""任务 Worker：并发消费任务表，按类型分发执行。TODO(M1/M5)。"""


class Worker:
    def __init__(self, count: int = 3):
        self.count = count

    async def start(self) -> None:
        raise NotImplementedError("M1")

    async def stop(self) -> None:
        raise NotImplementedError("M1")
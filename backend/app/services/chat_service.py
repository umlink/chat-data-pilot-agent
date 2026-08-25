"""ChatService：对话编排（Agent 循环 + Block 组装）。
契约见 docs/Block与协议规范.md 第 4 章。TODO(M2)：实现。
"""


class ChatService:
    async def process_message(self, *, session_id, user_text, datasource_id=None, attachments=None):
        raise NotImplementedError("M2")
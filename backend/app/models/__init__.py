"""ORM 模型注册：init_db() 通过 import 本模块发现全部表。"""
from app.models.analytics import ReportRun, SavedChart, ScheduledReport
from app.models.config import Config
from app.models.datasource import Attachment, Datasource, Template
from app.models.llm_provider import LlmProvider
from app.models.log import Log
from app.models.task import Task
from app.models.user import Feedback, Message, Session, User

__all__ = [
    "User",
    "Session",
    "Message",
    "Feedback",
    "Datasource",
    "Attachment",
    "Template",
    "Task",
    "Config",
    "Log",
    "LlmProvider",
    "SavedChart",
    "ScheduledReport",
    "ReportRun",
]

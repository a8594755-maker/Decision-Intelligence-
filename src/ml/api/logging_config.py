"""
Structured Logging Configuration for Decision-Intelligence API.

Sets up JSON or text logging based on DI_LOG_FORMAT env var.
Provides contextvars for per-request tracing (request_id, actor_id).

Environment variables:
  DI_LOG_FORMAT  — "json" (default) or "text"
  DI_LOG_LEVEL   — Python log level (default: "INFO")
"""

import contextvars
import logging
import os
import sys
from typing import Optional

# Context variables for per-request tracing
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default=""
)
actor_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "actor_id", default=""
)


class RequestContextFilter(logging.Filter):
    """Injects request_id and actor_id into every log record."""

    def filter(self, record):
        record.request_id = request_id_var.get("")
        record.actor_id = actor_id_var.get("")
        return True


def configure_logging():
    """
    Configure structured logging for the application.
    Call once at startup, before any getLogger() calls.
    """
    log_format = os.getenv("DI_LOG_FORMAT", "json").lower()
    log_level = os.getenv("DI_LOG_LEVEL", "INFO").upper()

    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, log_level, logging.INFO))

    # Remove existing handlers
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)

    if log_format == "json":
        try:
            from pythonjsonlogger import jsonlogger

            formatter = jsonlogger.JsonFormatter(
                fmt="%(asctime)s %(name)s %(levelname)s %(message)s "
                "%(request_id)s %(actor_id)s",
                rename_fields={
                    "asctime": "timestamp",
                    "levelname": "level",
                    "name": "logger",
                },
            )
            handler.setFormatter(formatter)
        except ImportError:
            # Fallback to text if python-json-logger not installed
            formatter = logging.Formatter(
                "%(asctime)s [%(levelname)s] %(name)s "
                "[rid=%(request_id)s actor=%(actor_id)s] %(message)s"
            )
            handler.setFormatter(formatter)
    else:
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s "
            "[rid=%(request_id)s actor=%(actor_id)s] %(message)s"
        )
        handler.setFormatter(formatter)

    # Add context filter to inject request_id/actor_id
    handler.addFilter(RequestContextFilter())
    root_logger.addHandler(handler)

    # Suppress noisy third-party loggers
    for noisy in ("uvicorn.access", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

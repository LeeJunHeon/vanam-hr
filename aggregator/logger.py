"""Aggregator 로깅. StreamHandler + RotatingFileHandler."""

import logging
import os
from logging.handlers import RotatingFileHandler


def setup_logger(log_level: str, log_file: str) -> logging.Logger:
    logger = logging.getLogger("aggregator")
    logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))

    # 이미 핸들러가 붙어 있으면 중복 방지
    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 콘솔
    ch = logging.StreamHandler()
    ch.setFormatter(formatter)
    logger.addHandler(ch)

    # 파일 (rotation, 5MB x 3개)
    if log_file:
        log_dir = os.path.dirname(log_file) or "."
        os.makedirs(log_dir, exist_ok=True)
        fh = RotatingFileHandler(
            log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        fh.setFormatter(formatter)
        logger.addHandler(fh)

    return logger

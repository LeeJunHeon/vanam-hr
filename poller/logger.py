"""MAC 마스킹 로깅. INFO에서는 마스킹, DEBUG에서만 풀 MAC."""

import logging
import os
from logging.handlers import RotatingFileHandler


def mask_mac(mac: str) -> str:
    """aabbccddeeff → aa:bb:cc:**:**:** (lowercase 12자리 입력 기준)"""
    cleaned = mac.replace(":", "").replace("-", "").replace(".", "").lower()
    if len(cleaned) != 12:
        return mac
    return f"{cleaned[0:2]}:{cleaned[2:4]}:{cleaned[4:6]}:**:**:**"


def setup_logger(log_level: str, log_file: str) -> logging.Logger:
    logger = logging.getLogger("poller")
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

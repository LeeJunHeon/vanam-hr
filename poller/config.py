"""환경변수 로드 + Config dataclass 정의."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 프로젝트 루트의 .env 로드 (poller/ 는 서브폴더이므로 부모 경로)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


@dataclass
class Config:
    database_url: str
    snmp_community: str
    log_level: str
    log_file: str
    dry_run: bool


def load_config() -> Config:
    db_url = os.environ.get("DATABASE_URL")
    community = os.environ.get("SNMP_COMMUNITY")
    if not db_url:
        raise SystemExit("DATABASE_URL 환경변수가 없습니다. .env 확인 필요.")
    if not community:
        raise SystemExit("SNMP_COMMUNITY 환경변수가 없습니다. .env 확인 필요.")
    return Config(
        database_url=db_url,
        snmp_community=community,
        log_level=os.environ.get("POLLER_LOG_LEVEL", "INFO"),
        log_file=os.environ.get("POLLER_LOG_FILE", "poller.log"),
        dry_run=os.environ.get("POLLER_DRY_RUN", "false").lower() == "true",
    )

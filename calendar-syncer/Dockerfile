FROM python:3.13-slim

WORKDIR /app

# 시스템 패키지:
# - libpq-dev: psycopg2-binary 백업용
# (SNMP 라이브러리는 calendar-syncer가 DB + HTTP만 사용하므로 불필요)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        build-essential \
        gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 빌드 도구는 설치 후 제거 (이미지 크기 축소)
RUN apt-get purge -y build-essential gcc \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# 로그 디렉토리
RUN mkdir -p /app/logs

CMD ["python", "syncer.py"]

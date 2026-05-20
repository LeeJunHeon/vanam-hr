FROM python:3.13-slim

WORKDIR /app

# psycopg2-binary는 wheel 형태로 제공되지만 만약을 위해 libpq 설치
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 로그 디렉토리
RUN mkdir -p /app/logs

CMD ["python", "poller.py"]

#!/bin/bash
set -euo pipefail

APP_DIR=/volume1/docker/hr-web
SERVICE=nextjs
CONTAINER=hr-nextjs
DONE_MSG="HR Next.js 배포 완료!"

# 컨테이너가 실행 중이면 0
is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]
}

# 본문 전체를 main 으로 감싼다 — git pull 이 실행 중에 이 파일을 바꿔도 이미 읽은 내용으로 끝까지 돈다.
main() {
  # root 가 아니면 root 로 다시 실행 (폴더 소유자가 달라 git safe.directory·docker 가 root 기준)
  if [ "$(id -u)" -ne 0 ]; then
    exec sudo -H bash "$0" "$@"
  fi

  cd "$APP_DIR"

  echo "[1/4] git pull"
  local safe_dirs
  safe_dirs=$(git config --global --get-all safe.directory || true)
  if ! grep -qxF "$APP_DIR" <<<"$safe_dirs"; then
    echo "      safe.directory 추가: $APP_DIR"
    git config --global --add safe.directory "$APP_DIR"
  fi
  git pull

  echo "[2/4] docker compose build $SERVICE"
  export BUILDX_GIT_INFO=0
  docker compose build "$SERVICE"

  # stop 없이 up -d — 이미지가 바뀌었으면 compose 가 알아서 컨테이너를 교체한다.
  echo "[3/4] docker compose up -d $SERVICE"
  docker compose up -d "$SERVICE"

  echo "[4/4] 실행 확인 ($CONTAINER, 최대 60초)"
  local waited=0
  local retried=0
  until is_running; do
    if [ "$retried" -eq 0 ]; then
      retried=1
      echo "      실행 중이 아님 — docker compose up -d $SERVICE 다시 실행"
      docker compose up -d "$SERVICE" || true
    fi
    if [ "$waited" -ge 60 ]; then
      docker ps -a --filter "name=$CONTAINER"
      docker logs --tail 30 "$CONTAINER" || true
      echo "배포 실패: 컨테이너가 실행 중이 아님"
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done

  git log --oneline -1
  docker ps --filter "name=$CONTAINER" --format '{{.Names}}  {{.Status}}'
  echo "$DONE_MSG"
}

main "$@"; exit $?

#!/bin/bash
set -e
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build calendar-syncer
sudo /usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container method="stop" version=1 name="hr-calendar-syncer" || true
sudo docker compose up -d calendar-syncer
echo "HR Calendar Syncer 배포 완료!"

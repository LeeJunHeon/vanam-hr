#!/bin/bash
set -e
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build calendar-syncer
sudo docker compose stop calendar-syncer
sudo docker compose up -d calendar-syncer
echo "HR Calendar Syncer 배포 완료!"

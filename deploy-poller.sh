#!/bin/bash
set -e
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build poller
sudo docker compose stop poller
sudo docker compose up -d poller
echo "HR Poller 배포 완료!"

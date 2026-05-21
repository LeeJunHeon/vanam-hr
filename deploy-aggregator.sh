#!/bin/bash
set -e
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build aggregator
sudo /usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container method="stop" version=1 name="hr-aggregator" || true
sudo docker compose up -d aggregator
echo "HR Aggregator 배포 완료!"

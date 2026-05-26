#!/bin/bash
set -e
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build icc_poller
sudo /usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container method="stop" version=1 name="hr-icc-poller" || true
sudo docker compose up -d icc_poller
echo "HR ICC Poller 배포 완료!"

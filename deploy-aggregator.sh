#!/bin/bash
set -e
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build aggregator
sudo docker compose stop aggregator
sudo docker compose up -d aggregator
echo "HR Aggregator 배포 완료!"

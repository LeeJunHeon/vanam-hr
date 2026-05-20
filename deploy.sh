#!/bin/bash
cd /volume1/docker/hr-web
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build nextjs
sudo /usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container method="stop" version=1 name="hr-nextjs"
sudo docker compose up -d nextjs
echo "HR Next.js 배포 완료!"

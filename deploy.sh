#!/bin/bash
cd /volume1/docker/vanam-hr
git pull
export BUILDX_GIT_INFO=0
sudo docker compose build nextjs
sudo /usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container method="stop" version=1 name="vanam-hr-nextjs"
sudo docker compose up -d nextjs
echo "배포 완료!"

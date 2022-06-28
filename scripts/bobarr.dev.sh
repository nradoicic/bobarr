#!/bin/bash
set -e # exit when error

cat << "EOF"

    /$$                 /$$
    | $$                | $$
    | $$$$$$$   /$$$$$$ | $$$$$$$   /$$$$$$   /$$$$$$   /$$$$$$
    | $$__  $$ /$$__  $$| $$__  $$ |____  $$ /$$__  $$ /$$__  $$
    | $$  \ $$| $$  \ $$| $$  \ $$  /$$$$$$$| $$  \__/| $$  \__/
    | $$  | $$| $$  | $$| $$  | $$ /$$__  $$| $$      | $$
    | $$$$$$$/|  $$$$$$/| $$$$$$$/|  $$$$$$$| $$      | $$
    |_______/  \______/ |_______/  \_______/|__/      |__/

        https://github.com/iam4x/bobarr

EOF

args=$1
shift;

stop_bobarr() {
  docker compose down --remove-orphans || true
}

after_start() {
  echo ""
  echo "bobarr started correctly, printing bobarr api logs"
  echo "you can close this and bobarr will continue to run in backgound"
  echo ""
  docker compose logs -f api
}

if [[ $args == 'start' ]]; then
  stop_bobarr
  docker compose up --force-recreate -d
  after_start
elif [[ $args == 'dev' ]]; then
  stop_bobarr
  docker compose \
    -f docker-compose.yml  \
    -f docker-compose.plex.yml \
    -f docker-compose.dev.yml \
    up --force-recreate -d
  after_start
elif [[ $args == 'recreate' ]]; then
  docker compose \
    -f docker-compose.yml  \
    -f docker-compose.plex.yml \
    -f docker-compose.dev.yml \
    up --build --force-recreate -d $@
  after_start
elif [[ $args == 'start:vpn' ]]; then
  stop_bobarr
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.plex.yml \
    -f docker-compose.vpn.yml \
    up --force-recreate -d
  after_start
elif [[ $args == 'start:wireguard' ]]; then
  stop_bobarr
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.plex.yml \
    -f docker-compose.wireguard.yml \
    up --force-recreate -d
  after_start
elif [[ $args == 'stop' ]]; then
  stop_bobarr
  echo ""
  echo "bobarr correctly stopped"
elif [[ $args == 'update' ]]; then
  docker compose pull
  echo ""
  echo "bobarr docker images correctly updated, you can now re-start bobarr"
else
  echo "unknow command: $args"
  echo "use [start | start:vpn | start:wireguard | stop | update]"
fi

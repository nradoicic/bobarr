#!/bin/bash
if [ $# -eq 0 ];then
  docker exec -it bobarr-postgresql psql --user bobarr bobarr
else
  docker exec -it bobarr-postgresql psql --user bobarr bobarr -P pager=off -c "$@"
fi

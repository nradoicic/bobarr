#!/bin/bash
docker exec -it bobarr-postgresql psql --user bobarr bobarr -c "UPDATE tv_episode SET state='downloaded' WHERE state in ('missing', 'searching');"

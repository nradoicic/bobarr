#!/bin/bash
docker exec -it bobarr-postgresql psql --user bobarr bobarr -c "UPDATE tv_show SET \"tmdbId\" = 64978 WHERE title='Whose Line Is It Anyway';"

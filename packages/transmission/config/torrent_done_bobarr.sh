#!/bin/bash

STAGE="/plex/library/filebot/stage"
QUEUE="/plex/library/filebot/queue"
DOWNLOADS="/plex/library/downloads/complete"

TORRENT_INPUT=${TR_TORRENT_NAME:-$1}

try_stage(){
  destination="${STAGE}/${TORRENT_INPUT}"
  job_id=$(ls "${destination}")
  if [ -d ${destination} ]; then
    echo "Found a bobarr directory ${destination}"
    output=$(find "${destination}" -type d -empty)
    if [[ -d ${SOURCE} ]];then
      cp -r "${SOURCE}/"* "${output}"
    else
      cp -r "${SOURCE}" "${output}"
    fi
    mv "${destination}/${job_id}" "${QUEUE}"
    rm -rf "${destination}"
    echo "Processed ${TORRENT_INPUT}"
    exit 0
  fi
}

echo "Finished download for ${TORRENT_INPUT}"

set -x
if [ ! -z "$TORRENT_INPUT" ]
then
  for i in {1..12}; do 
    # 1 minute of retry
    try_stage
    sleep 5
  done;
  cp -r "${DOWNLOADS}/${TORRENT_INPUT}" "${STAGE}"
  mv "${STAGE}/${TORRENT_INPUT}" "${QUEUE}"
  echo "PROCESSED ${TORRENT_INPUT}"
fi

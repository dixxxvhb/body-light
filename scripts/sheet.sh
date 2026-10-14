#!/usr/bin/env bash
# Record a clip off the canvas and tile it into a contact sheet for worst-frame review.
# usage: scripts/sheet.sh <clip> <mode> <tag> [extra query]
set -e
node scripts/qa.mjs --clip "$1" --mode "$2" --frames 1 --tag "$3" --record "${5:-6}" --q "${4:-}" | grep -E '"(fps|worstMs|detectMs)"|error' | tr -d ' \n'; echo
ffmpeg -v error -y -i "qa/out/$3.webm" -vf "fps=12,crop=iw*0.8:ih*0.92:iw*0.1:ih*0.04,scale=400:-1,tile=6x4" -frames:v 1 "qa/out/$3-sheet.png"

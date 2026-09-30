#!/bin/sh
# Runs mx2's training, sleep-safe. Started by the LaunchAgent that
# `ai --train start` installs; safe to run by hand too.
#
#  - caffeinate keeps the Mac from idle-sleeping while it trains (closing the
#    lid still sleeps it).
#  - sleepwatch saves a checkpoint before any sleep and lets the Mac sleep
#    only once it's written; after waking, training just carries on.
#  - If training stops for any reason (crash, restart, logout), launchd starts
#    this again and it resumes from the last checkpoint.
cd "$(dirname "$0")/../.." || exit 1
DATA=ai/mx2/data
LOG=$DATA/train.log
CACHE=${MAXSHELL_CACHE:-$HOME/.cache/maxshell}
PY=${MX2_PYTHON:-/Library/Frameworks/Python.framework/Versions/3.13/bin/python3}

[ -f "$DATA/done" ] && exit 0
mkdir -p "$CACHE"
touch "$LOG"

if [ ! -x "$CACHE/sleepwatch" ] || [ ai/mx2/sleepwatch.swift -nt "$CACHE/sleepwatch" ]; then
  /usr/bin/swiftc -O ai/mx2/sleepwatch.swift -o "$CACHE/sleepwatch" >> "$LOG" 2>&1
fi

echo "=== training started $(date '+%Y-%m-%d %H:%M') ===" >> "$LOG"
PYTHONUNBUFFERED=1 "$PY" ai/mx2/train.py "$@" >> "$LOG" 2>&1 &
TRAIN=$!
trap 'kill -TERM $TRAIN 2>/dev/null; wait $TRAIN; exit 0' TERM INT HUP

[ -x "$CACHE/sleepwatch" ] && "$CACHE/sleepwatch" "$TRAIN" "$LOG" "$DATA/saved.ack" &
/usr/bin/caffeinate -i -w "$TRAIN" &

wait $TRAIN
status=$?
[ -f "$DATA/done" ] && exit 0
exit $status

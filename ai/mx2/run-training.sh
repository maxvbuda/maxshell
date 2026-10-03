#!/bin/sh
# Runs a model's training, sleep-safe:  run-training.sh <name> [train.py args]
# (name mx2 or mx3; extra arguments also come from ai/<name>/train.args).
# Started by the LaunchAgent that `ai --train start` installs; safe to run
# by hand too.
#
#  - caffeinate keeps the Mac from idle-sleeping while it trains (closing the
#    lid still sleeps it).
#  - sleepwatch saves a checkpoint before any sleep and lets the Mac sleep
#    only once it's written; after waking, training just carries on.
#  - If training stops for any reason (crash, restart, logout), launchd starts
#    this again and it resumes from the last checkpoint.
cd "$(dirname "$0")/../.." || exit 1
NAME=${1:-mx2}
[ $# -gt 0 ] && shift
DATA=ai/$NAME/data
ARGS=$(cat "ai/$NAME/train.args" 2>/dev/null)
LOG=$DATA/train.log
CACHE=${MAXSHELL_CACHE:-$HOME/.cache/maxshell}
PY=${MX2_PYTHON:-/Library/Frameworks/Python.framework/Versions/3.13/bin/python3}

# A second stage (ai/<name>/train2.args) starts from the first's weights
# once it's done.
if [ -f "$DATA/done" ] && [ -f "ai/$NAME/train2.args" ] && [ ! -f "$DATA/stage2" ]; then
  mv "$DATA/ckpt.pt" "$DATA/stage1.pt"
  rm -f "$DATA/done"
  touch "$DATA/stage2"
  echo "=== stage 1 finished; starting stage 2 $(date '+%Y-%m-%d %H:%M') ===" >> "$DATA/train.log"
fi
[ -f "$DATA/stage2" ] && ARGS=$(cat "ai/$NAME/train2.args")
[ -f "$DATA/done" ] && exit 0
mkdir -p "$CACHE"
touch "$LOG"

if [ ! -x "$CACHE/sleepwatch" ] || [ ai/mx2/sleepwatch.swift -nt "$CACHE/sleepwatch" ]; then
  /usr/bin/swiftc -O ai/mx2/sleepwatch.swift -o "$CACHE/sleepwatch" >> "$LOG" 2>&1
fi

echo "=== training started $(date '+%Y-%m-%d %H:%M') ===" >> "$LOG"
# shellcheck disable=SC2086  # train.args holds several words
PYTHONUNBUFFERED=1 "$PY" ai/mx2/train.py --name "$NAME" $ARGS "$@" >> "$LOG" 2>&1 &
TRAIN=$!
trap 'kill -TERM $TRAIN 2>/dev/null; wait $TRAIN; exit 0' TERM INT HUP

[ -x "$CACHE/sleepwatch" ] && "$CACHE/sleepwatch" "$TRAIN" "$LOG" "$DATA/saved.ack" &
/usr/bin/caffeinate -i -w "$TRAIN" &

wait $TRAIN
status=$?
# Stage 1 done and a stage 2 waiting: exit non-zero, so launchd starts
# this script again, which begins stage 2 (see the top).
if [ -f "$DATA/done" ] && [ -f "ai/$NAME/train2.args" ] && [ ! -f "$DATA/stage2" ]; then
  exit 75
fi
[ -f "$DATA/done" ] && exit 0
exit $status

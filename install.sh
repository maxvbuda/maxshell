#!/bin/sh
# Installs maxshell from this folder and offers to make it your default
# shell.   git clone https://github.com/maxvbuda/maxshell && cd maxshell && ./install.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "maxshell needs Node.js 16 or newer. Install it first, e.g.: brew install node" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 16 ]; then
  echo "maxshell needs Node.js 16 or newer (this is $(node -v))." >&2
  exit 1
fi

echo "Installing the maxshell command…"
if ! npm link >/dev/null 2>&1; then
  echo "  (npm link needs permission here; trying with sudo)"
  sudo npm link >/dev/null
fi
echo "  ✓ $(command -v maxshell || echo maxshell) — maxshell $(node bin/maxshell.js --version | cut -d' ' -f2)"

printf "\nMake maxshell your default shell, so every new terminal opens in it? [Y/n] "
read -r answer || answer=n
case "$answer" in
  [nN]*) echo "Okay. Run  maxshell --make-default  whenever you like." ;;
  *) node bin/maxshell.js --make-default ;;
esac
# The first-run question inside maxshell has been answered here.
node -e 'const s=require("./src/setup");s.writeState({askedDefault:true})'
echo "\nStart it now with:  maxshell"

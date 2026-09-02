#!/bin/bash
# Double-click this file in Finder to pull the latest version from GitHub.
# (First time only: right-click -> Open, since it's an unsigned script —
# macOS blocks a plain double-click on a downloaded .command file once.)
cd "$(dirname "$0")"
echo "Pulling latest changes..."
git pull
echo ""
echo "Done. Now go to chrome://extensions and click the reload icon on the Commute Blocker card."
read -p "Press Enter to close this window..."

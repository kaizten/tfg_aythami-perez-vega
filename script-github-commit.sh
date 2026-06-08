#!/bin/bash

#####################################################################################################################################################
# DESCRIPTION: 
#   It updates the current GitHub repository with the last changes. 
# USAGE: ./script-commit-github.sh [options]
# OPTIONS:
#   -d|--default   Generate a simple random message using date and shell random
#   -h|--help      Display help message
#   -m|--message   Commit message (if not provided, it will ask for it)
# NOTES:
#   - This script requires git to be installed.
# AUTHOR: 
#   Kaizten Analytics S.L. (development@kaizten.com)
#####################################################################################################################################################

main () {
  message=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -m|--message)
        message="$2"
        shift 2
        ;;
      -d|--default)
        # generate a simple random message using date and shell random
        message="Auto-update $(date +%Y-%m-%d_%H:%M:%S) ${RANDOM}"
        shift
        ;;
      -h|--help)
        echo "ℹ️  Usage: $0 [-m|--message \"commit message\"] [-d|--default]"
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done

  echo "📥 Pulling repository..."
  git pull
  if [ $? -eq 0 ]; then
    git add .
    set +e
    if [ -n "$(git status --porcelain)" ]; then
      if [ -z "$message" ]; then
        read -p "✏️  Enter your message in the commit: " message
      fi
      set -e
      git commit -m "${message}"
      echo "🚀 Pushing data to remote GitHub repository:"
      git push
      echo "✅ Done!"
    else
      set -e
      echo "ℹ️  Nothing to update"
    fi
  else
    echo "❌ ERROR. Conflicts must be solved."
    exit
  fi
}

main "$@"; exit

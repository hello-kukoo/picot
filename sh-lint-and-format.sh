#!/bin/bash

echo "Running lint:fix → format:fix → check sequentially..."
echo ""

run_step() {
  local name="$1"
  shift
  echo "[$name] Starting..."
  if "$@"; then
    echo "[$name] ✓ Completed successfully"
    echo ""
  else
    echo ""
    echo "[$name] ✗ Failed"
    exit 1
  fi
}

BUN_CMD="npx bun"

run_step "lint:fix"   $BUN_CMD run lint:fix
run_step "format:fix" $BUN_CMD run format:fix
run_step "check"      $BUN_CMD run check

echo "✓ All tasks completed successfully!"

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_FILE="${REPO_ROOT}/current-diff.md"
TIMESTAMP="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
DIFF_COMMAND=(git diff -- . ':(exclude)current-diff.md')
DIFF_COMMAND_DISPLAY="git diff -- . ':(exclude)current-diff.md'"

cd "${REPO_ROOT}"

{
  printf '# Current Diff\n\n'
  printf 'Generated: `%s`\n\n' "${TIMESTAMP}"
  printf 'Source: `%s`\n\n' "${DIFF_COMMAND_DISPLAY}"
  printf '```diff\n'
  "${DIFF_COMMAND[@]}"
  printf '\n```\n'
} > "${OUTPUT_FILE}"

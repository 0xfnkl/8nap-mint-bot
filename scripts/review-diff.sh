#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_FILE="${REPO_ROOT}/current-diff.md"
TIMESTAMP="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
DIFF_COMMAND=(git diff HEAD -- . ':(exclude)current-diff.md')
DIFF_COMMAND_DISPLAY="git diff HEAD plus non-ignored untracked files"

cd "${REPO_ROOT}"

{
  printf '# Current Diff\n\n'
  printf 'Generated: `%s`\n\n' "${TIMESTAMP}"
  printf 'Source: `%s`\n\n' "${DIFF_COMMAND_DISPLAY}"
  printf '```diff\n'
  "${DIFF_COMMAND[@]}"
  while IFS= read -r -d '' file; do
    # git diff omits new files until staged. Include them without changing the index.
    if [[ "${file}" == "current-diff.md" ]]; then continue; fi
    status=0
    git diff --no-index -- /dev/null "${file}" || status=$?
    if (( status > 1 )); then exit "${status}"; fi
  done < <(git ls-files --others --exclude-standard -z)
  printf '\n```\n'
} > "${OUTPUT_FILE}"

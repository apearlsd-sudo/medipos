#!/bin/bash
# Debug why NAV eval fails for & labels in task81-audit.sh
label="$1"
# Extract the NAV='...' block verbatim from the audit script (lines between NAV=' and the closing )()'
NAV=$(awk "/^NAV='/{flag=1;next}/^\}'\$/flag=0}flag" /home/z/my-project/scripts/task81-audit.sh)
NAVJS="${NAV//__LABEL__/$label}"
echo "--- NAVJS (first 200 chars) ---"
printf '%s' "$NAVJS" | head -c 200; echo
echo "--- eval result ---"
agent-browser eval "$NAVJS"; echo "exit=$?"

#!/usr/bin/env bash
# Installs a git post-commit hook that re-runs the UX probe after every commit
# (in the background) and refreshes monitor/HANDOFF.md for the dev session to read.
# Run once: bash monitor/install-hooks.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/post-commit"

cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# MyRadio: after each commit, refresh the UX findings handoff in the background.
ROOT="$(git rev-parse --show-toplevel)"
LOG="${TMPDIR:-/tmp}/myradio-uxprobe.log"
(
  PROBE_TIME="$(date -u +%Y-%m-%dT%H:%MZ)" \
  node "$ROOT/monitor/ux-probe.mjs" >"$LOG" 2>&1
  # If a Slack webhook is exported in the environment, ping on high-severity findings.
  if [ -n "${SLACK_WEBHOOK_URL:-}" ] && grep -q '\[HIGH\]' "$LOG"; then
    SUMMARY="$(grep '\[HIGH\]\|\[MED\]' "$LOG" | head -8)"
    node -e "fetch(process.env.SLACK_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'🟡 MyRadio UX probe (post-commit '+process.argv[1].slice(0,7)+'):\n'+process.argv[2]+'\nSee monitor/HANDOFF.md'})}).catch(()=>{})" "$(git rev-parse HEAD)" "$SUMMARY" || true
  fi
) >/dev/null 2>&1 &
disown 2>/dev/null || true
HOOK_EOF

chmod +x "$HOOK"
echo "Installed post-commit hook -> $HOOK"
echo "After every commit it refreshes monitor/HANDOFF.md (background). Log: \${TMPDIR}/myradio-uxprobe.log"

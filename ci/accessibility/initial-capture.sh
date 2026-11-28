#!/usr/bin/env bash
# Retry only the initial, read-only capture after a diagnosed Android failure.
set -euo pipefail
target=com.mooneva.app.debug
cli="$RUNNER_TEMP/aloud/bin/aloud.mjs"
mkdir -p diagnostics/initial-attempts
for attempt in 1 2 3; do
  evidence="diagnostics/initial-attempts/$attempt"
  mkdir -p "$evidence"
  report=aloud-report
  ready=readiness
  if [ "$attempt" -gt 1 ]; then
    report="aloud-report-retry/attempt-$attempt"
    ready="readiness-retry/attempt-$attempt"
  fi
  # Use the guest clock, not runner wall time, to scope the log to this attempt.
  since="$(adb shell date '+%m-%d %H:%M:%S.000' | tr -d '\r')"
  if (
    set -e
    adb shell am start -W -n "$target/com.mooneva.app.MainActivity" &&
    node "$cli" android-ready --target "$target" --out "$ready" &&
    node "$cli" android --config ci/accessibility/aloud.config.json --nav current-screen --screen-id onboarding-language --talkback focus --tts logging --talkback-max-steps 200 --no-gate --out "$report"
  ) > "$evidence/capture.log" 2>&1; then
    cat "$evidence/capture.log"
    # Match the same strict traversal evidence as the extended journey.
    node --input-type=module - "$report" <<'NODE'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const s=JSON.parse(readFileSync(process.argv[2]+'/android/summary.json','utf8')).screens['onboarding-language'];
assert.equal(s?.transcriptSource,'talkback-focus');
assert.equal(s?.talkBackFocus?.coverage?.complete,true);
assert.ok(s.utterances>0);
assert.equal(s.talkBackFocus.speechSource,'logging-tts');
NODE
    printf 'observed on attempt %s\n' "$attempt" | tee "$evidence/result.txt"
    exit 0
  fi
  cat "$evidence/capture.log"
  adb logcat -d -T "$since" > "$evidence/logcat.txt" || true
  adb shell dumpsys activity exit-info "$target" > "$evidence/app-exit-info.txt" || true
  adb shell dumpsys activity activities > "$evidence/activity.txt" || true
  adb shell pidof "$target" > "$evidence/app-pid.txt" || true
  reason=unclassified
  if grep -E "Killing [0-9]+:$target/.*depends on provider com.google.android.gms/.*FontsProvider" "$evidence/logcat.txt" >/dev/null; then
    reason=gms-font-provider-death
  elif grep -E 'Android accessibility capture failed:.*uiautomator dump' "$evidence/capture.log" >/dev/null &&
       grep -A4 'FATAL EXCEPTION: UiAutomation' "$evidence/logcat.txt" | grep -F 'Bad file descriptor' >/dev/null; then
    reason=uiautomation-binder-error
  fi
  printf 'failed: %s\n' "$reason" | tee "$evidence/result.txt"
  if [ "$reason" = unclassified ] || [ "$attempt" -eq 3 ]; then
    exit 1
  fi
  # Do not reset application data, change motion settings, or retry semantic failures.
  node "$cli" talkback disable
  adb shell rm -f /sdcard/a11y-dump.xml
  if [ "$reason" = gms-font-provider-death ]; then
    deadline=$((SECONDS + 180))
    previous=""
    stable=0
    while [ "$SECONDS" -lt "$deadline" ]; do
      pid="$(timeout 10s adb shell pidof com.google.android.gms.persistent | tr -d '\r' || true)"
      if [ -n "$pid" ] && [ "$pid" = "$previous" ]; then
        stable=$((stable + 5))
      else
        stable=0
      fi
      previous="$pid"
      printf '%s pid=%s stable=%s\n' "$(date -u +%FT%TZ)" "$pid" "$stable" >> "$evidence/gms-recovery.txt"
      if [ "$stable" -ge 60 ]; then break; fi
      sleep 5
    done
    test "$stable" -ge 60
  else
    sleep 5
  fi
done
exit 1

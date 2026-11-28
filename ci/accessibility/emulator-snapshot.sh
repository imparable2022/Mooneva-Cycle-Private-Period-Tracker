#!/usr/bin/env bash
# Only a clean, stopped AVD is cached. No Mooneva APK or test data in it.
set -euo pipefail
export ANDROID_AVD_HOME="$HOME/.android/avd"
sdk="${ANDROID_HOME:?}"
emu="$sdk/emulator/emulator"
image="system-images;android-34;google_apis;x86_64"
name=aloud-ci
snapshot=mooneva-clean
cli="$RUNNER_TEMP/aloud/bin/aloud.mjs"
pidfile="$RUNNER_TEMP/mooneva-emulator.pid"
mkdir -p diagnostics "$ANDROID_AVD_HOME"

stop_emulator() {
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    timeout 15s adb emu kill || true
    for i in $(seq 1 30); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for i in $(seq 1 10); do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 1
      done
    fi
    ! kill -0 "$pid" 2>/dev/null || return 1
    rm -f "$pidfile"
  fi
}
cold_avd() {
  rm -rf "$ANDROID_AVD_HOME/$name.avd" "$ANDROID_AVD_HOME/$name.ini"
  echo no | "$sdk/cmdline-tools/latest/bin/avdmanager" create avd -n "$name" -k "$image" -d pixel_7 --force
}
boot() {
  local mode="$1" logfile="$RUNNER_TEMP/emulator.log" pid deadline status
  local -a flags=(-no-snapshot-save)
  if [ "$mode" = snapshot ]; then
    flags+=(-snapshot "$snapshot")
  else
    flags+=(-no-snapshot-load)
  fi
  nohup "$emu" -avd "$name" -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -memory 3072 -cores 2 "${flags[@]}" > "$logfile" 2>&1 &
  pid=$!
  echo "$pid" > "$pidfile"
  deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || return 1
    status="$(timeout 5s adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [ "$status" = 1 ] && timeout 10s adb shell pm path android | grep -q '^package:'; then
      return 0
    fi
    sleep 5
  done
  return 1
}
reader_installed() {
  timeout 10s adb shell pm path com.android.talkback | grep -q '^package:'
}
app_absent() {
  local result
  result="$(timeout 10s adb shell pm list packages com.mooneva.app 2>&1)" || return 1
  ! grep -q '^package:com.mooneva.app' <<< "$result"
}
snapshot_exists() {
  test -d "$ANDROID_AVD_HOME/$name.avd/snapshots/$snapshot"
}
case "${1:?prepare or start}" in
  prepare)
    echo 'created=false' >> "$GITHUB_OUTPUT"
    cold_avd
    if boot cold && node "$cli" talkback install "$ALOUD_CACHE/talkback.apk" &&
      node "$cli" tts install "$ALOUD_CACHE/logging-tts.apk" &&
      reader_installed && app_absent; then
      if timeout 120s adb emu avd snapshot save "$snapshot" > diagnostics/snapshot-save.txt 2>&1 &&
        grep -q '^OK' diagnostics/snapshot-save.txt && snapshot_exists; then
        stop_emulator
        cp "$RUNNER_TEMP/emulator.log" diagnostics/snapshot-create-emulator.log
        echo 'created=true' >> "$GITHUB_OUTPUT"
        exit 0
      fi
    fi
    echo 'Snapshot preparation unavailable; use cold boot.' | tee -a diagnostics/snapshot-save.txt
    stop_emulator
    rm -rf "$ANDROID_AVD_HOME/$name.avd" "$ANDROID_AVD_HOME/$name.ini"
    ;;
  start)
    if snapshot_exists && boot snapshot && reader_installed && app_absent; then
      echo 'snapshot' | tee diagnostics/emulator-start-mode.txt
      exit 0
    fi
    if [ -f "$pidfile" ]; then
      cp "$RUNNER_TEMP/emulator.log" diagnostics/snapshot-restore-failed.log || true
      stop_emulator
    fi
    cold_avd
    boot cold
    app_absent
    echo 'cold' | tee diagnostics/emulator-start-mode.txt
    ;;
  *) exit 2 ;;
esac

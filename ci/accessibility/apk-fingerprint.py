#!/usr/bin/env python3
"""Fingerprint all tracked build inputs and the APK job recipe."""
import hashlib
import subprocess
from pathlib import Path

def fingerprint():
    digest = hashlib.sha256(b"mooneva-apk-input-v1\0")
    tree = subprocess.check_output(["git", "ls-tree", "-r", "-z", "HEAD"])
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        _, path = entry.split(b"\t", 1)
        # Only exclude this test harness and the workflow whose APK job is
        # included separately. Unknown future paths invalidate the cache.
        if path.startswith(b"ci/accessibility/") or path == b".github/workflows/accessibility-baseline.yml":
            continue
        digest.update(entry + b"\0")
    workflow = Path(".github/workflows/accessibility-baseline.yml").read_bytes()
    digest.update(workflow.split(b"  apk:\n", 1)[1].split(b"  web:\n", 1)[0])
    return digest.hexdigest()

if __name__ == "__main__":
    print(fingerprint())

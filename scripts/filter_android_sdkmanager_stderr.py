#!/usr/bin/env python3
import sys

SDKMANAGER_DEPRECATION = (
    "WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. "
    "Use Android CLI instead."
)

for line in sys.stdin:
    if line.rstrip("\r\n") != SDKMANAGER_DEPRECATION:
        sys.stderr.write(line)

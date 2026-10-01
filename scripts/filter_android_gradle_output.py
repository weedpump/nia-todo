#!/usr/bin/env python3
import sys

NULL_ATTRIBUTE_DEPRECATION = (
    "Retrieving attribute with a null key. This behavior has been deprecated. "
    "This will fail with an error in Gradle 10.0. Don't request attributes from "
    "attribute containers using null keys. Consult the upgrading guide for further "
    "information: https://docs.gradle.org/8.14.3/userguide/upgrading_version_8.html"
    "#null-attribute-lookup"
)

for line in sys.stdin:
    if line.rstrip("\r\n") != NULL_ATTRIBUTE_DEPRECATION:
        sys.stdout.write(line)

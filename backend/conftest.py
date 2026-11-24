"""Shared pytest setup for the backend tests.

main.py reads C2A_JWT_SECRET once, when it is first imported, and whichever
test module pytest collects first is the one that imports it. Setting the
variable here, before any test module loads, keeps every module seeing the
same value regardless of collection order. It is the same obviously fake
fixture value test_ops_ci.py mints its tokens with.
"""

import base64
import os

os.environ.setdefault(
    "C2A_JWT_SECRET", base64.b64encode(b"unit-test-secret-value").decode()
)

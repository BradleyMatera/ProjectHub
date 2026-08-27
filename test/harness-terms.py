#!/usr/bin/env python3
"""Regression tests for the conversation-harness evidence matcher.

Run with:
    python3 test/harness-terms.py
"""

import importlib.util
import os
import re
import sys
import traceback

# Load the harness matcher from the parent directory.
_SPEC = importlib.util.spec_from_file_location(
    "test_production_conversations",
    os.path.join(os.path.dirname(__file__), "..", "test-production-conversations.py"),
)
_harness = importlib.util.module_from_spec(_SPEC)
# Allow the module to load even if it is not named like a valid package.
_SPEC.loader.exec_module(_harness)

evidence_term_regex = _harness.evidence_term_regex


def _matches(term, text):
    return bool(evidence_term_regex(term).search(text))


def run_tests():
    passed = 0
    failed = 0

    # Positive: legitimate inflections
    positive = [
        ("blog", "Bradley has written blogs."),
        ("debug", "He has experience debugging issues."),
        ("algorithm", "He studies algorithms and data structures."),
        ("learn", "He learns quickly."),
        ("learn", "He is learning quickly."),
        ("code", "He is coding."),
        ("data structure", "Data structures are a gap."),
        ("mentor", "Mentors can help."),
        ("mentor", "He would benefit from mentoring."),
        ("customer", "He worked with customers."),
        ("responsibility", "He has many responsibilities."),
        ("collaborate", "He is collaborating well."),
        ("collaboration", "He values collaboration."),
        ("case manager", "He was a case manager."),
        ("case manager", "He worked as one of the case managers."),
        ("github actions", "They used GitHub Actions for CI."),
    ]

    # Negative: unrelated prefix / compound words must NOT match
    negative = [
        ("js", "json data"),
        ("git", "github repository"),
        ("react", "reactive programming"),
        ("go", "google cloud"),
        ("any", "many"),
        ("sql", "sqlite database"),
        ("node", "nodejs runtime"),
        ("code", "codependent"),
        ("post", "posture"),
        ("test", "testosterone"),
    ]

    for term, text in positive:
        if _matches(term, text):
            print(f"PASS  positive: '{term}' matches in \"{text}\"")
            passed += 1
        else:
            print(f"FAIL  positive: '{term}' did NOT match in \"{text}\"")
            failed += 1

    for term, text in negative:
        if not _matches(term, text):
            print(f"PASS  negative: '{term}' does NOT match in \"{text}\"")
            passed += 1
        else:
            print(f"FAIL  negative: '{term}' wrongly matched in \"{text}\"")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    ok = run_tests()
    sys.exit(0 if ok else 1)

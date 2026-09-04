#!/usr/bin/env python3
"""Regression tests for the conversation-harness evidence matcher.

Run with:
    python3 test/harness-terms.py
"""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import traceback
import unittest
from unittest.mock import Mock, call, patch

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


class QualificationInstrumentationTests(unittest.TestCase):
    def http_response(self, payload, status=200):
        response = Mock()
        response.code = status
        response.headers = {"X-Trace-Id": "trace-123"}
        response.read.return_value = json.dumps(payload).encode("utf-8")
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def test_http_status_headers_body_and_history(self):
        payload = {"reply": "COBOL " * 300, "provider": "cloudflare", "agentEvents": [{"rawAnswer": "x" * 2000}]}
        history = [{"user": str(i), "assistant": "reply"} for i in range(8)]
        with patch.object(_harness.urllib.request, "urlopen", return_value=self.http_response(payload)) as send:
            result = _harness.send_message("http://unused/api/chat", "say cobol", "session", history, diagnose=True)
        self.assertEqual(result["httpStatus"], 200)
        self.assertEqual(result["httpHeaders"], [("X-Trace-Id", "trace-123")])
        self.assertEqual(result["response"], payload)
        self.assertEqual(json.loads(result["rawBody"]), payload)
        request = json.loads(send.call_args.args[0].data)
        self.assertEqual(request["history"], history[-5:])
        self.assertEqual(request["sessionId"], "session")
        self.assertTrue(request["gateDebug"])
        self.assertEqual(send.call_args.kwargs["timeout"], 20)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(len(history), 8)

    def test_http_errors_preserve_payload_and_are_not_retried(self):
        for status, label in [(429, "RATE_LIMIT"), (503, "INFRASTRUCTURE"), (401, "HTTP_ERROR")]:
            with self.subTest(status=status):
                payload = {"reply": "Please wait", "diagnostics": {"failureStage": "test"}}
                error = _harness.urllib.error.HTTPError("http://unused", status, "failure", {"Retry-After": "5"}, io.BytesIO(json.dumps(payload).encode()))
                with patch.object(_harness.urllib.request, "urlopen", side_effect=error) as send:
                    result = _harness.send_message("http://unused", "hi", "s", [])
                self.assertEqual(result["httpStatus"], status)
                self.assertEqual(result["response"], payload)
                self.assertIn(("Retry-After", "5"), result["httpHeaders"])
                self.assertEqual(_harness.classify_failure([f"HTTP status {status}"], payload, 1, status), label)
                self.assertEqual(send.call_count, 1)

    def test_non_json_rate_limit_is_not_misreported_as_infrastructure(self):
        error = _harness.urllib.error.HTTPError("http://unused", 429, "limited", {}, io.BytesIO(b"<html>rate limited</html>"))
        with patch.object(_harness.urllib.request, "urlopen", side_effect=error):
            result = _harness.send_message("http://unused", "hi", "s", [])
        self.assertEqual(result["rawBody"], "<html>rate limited</html>")
        self.assertEqual(_harness.failure_classes(["HTTP status 429", "invalid response: test"], {}, 1, result["httpStatus"], result["transportError"], result["decodeError"]), ["RATE_LIMIT"])

    def test_transport_and_invalid_responses_fail_closed(self):
        for error in [_harness.urllib.error.URLError("offline"), TimeoutError("timeout"), ConnectionResetError("reset")]:
            with self.subTest(error=error), patch.object(_harness.urllib.request, "urlopen", side_effect=error) as send:
                result = _harness.send_message("http://unused", "hi", "s", [])
                self.assertIsNone(result["httpStatus"])
                self.assertTrue(result["transportError"])
                self.assertEqual(_harness.failure_classes(["request failed: offline"], {}, 16, transport_error=result["transportError"]), ["INFRASTRUCTURE", "LATENCY"])
                self.assertEqual(send.call_count, 1)
        for body in [b"not json", b"[]", b"null", b"\xff"]:
            with self.subTest(body=body):
                response = self.http_response({})
                response.read.return_value = body
                with patch.object(_harness.urllib.request, "urlopen", return_value=response):
                    result = _harness.send_message("http://unused", "hi", "s", [])
                self.assertEqual(result["httpStatus"], 200)
                self.assertTrue(result["decodeError"])
                self.assertEqual(_harness.base64.b64decode(result["rawBodyBase64"]), body)
                self.assertEqual(_harness.classify_failure(["invalid response: test"], {}, 1, 200, decode_error=result["decodeError"]), "INFRASTRUCTURE")

    def test_partial_transport_preserves_status_and_received_body(self):
        response = self.http_response({})
        response.read.side_effect = _harness.http.client.IncompleteRead(b'{"reply":"partial', 20)
        with patch.object(_harness.urllib.request, "urlopen", return_value=response):
            result = _harness.send_message("http://unused", "hi", "s", [])
        self.assertEqual(result["httpStatus"], 200)
        self.assertEqual(result["rawBody"], '{"reply":"partial')
        self.assertIn("IncompleteRead", result["transportError"])

    def test_latency_is_separate_and_deadline_is_unchanged(self):
        self.assertEqual(_harness.MAX_LATENCY_SECONDS, 15.0)
        self.assertEqual(sum(len(turns) for _, turns in _harness.PRODUCTION_CONVERSATIONS), 132)
        self.assertEqual(_harness.check_reply("say cobol", "COBOL", {"provider": "cloudflare"}, "", 15), [])
        issues = _harness.check_reply("say cobol", "COBOL", {"provider": "cloudflare"}, "", 15.01)
        self.assertEqual(len(issues), 1)
        self.assertEqual(_harness.failure_classes(issues, {}, 15.01, 200), ["LATENCY"])
        self.assertEqual(_harness.failure_classes(issues + ["missing 'cobol'"], {}, 16, 429), ["RATE_LIMIT", "LATENCY"])
        self.assertEqual(_harness.failure_classes(issues + ["missing 'cobol'"], {}, 16, 200), ["LATENCY", "GENERATION"])

    def test_existing_semantic_classes(self):
        cases = [
            (["near-duplicate consecutive answer"], {}, "NEAR_DUPLICATE"),
            (["reply is too short"], {}, "GENERATION"),
            (["missing evidence"], {"contract": {"directAnswer": "UNKNOWN"}}, "HARNESS"),
            (["non-local source"], {}, "PROVIDER"),
            (["contains forbidden 'test'"], {}, "OTHER"),
            (["reply is too short"], {"error": "INFERENCE_UNAVAILABLE", "pipeline": ["deadline"]}, "DEADLINE"),
            (["reply is too short"], {"error": "INFERENCE_UNAVAILABLE", "agent": {"validation": "unsupported"}}, "VALIDATION"),
        ]
        for issues, response, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(_harness.classify_failure(issues, response, 1, 200), expected)

    def test_validation_rejections_are_not_provider_failures_or_new_score_failures(self):
        rejected = {"accepted": False, "validationVerdict": "unsupported", "validationReasons": ["forbidden_claim"], "rawAnswer": "x" * 2000}
        accepted = {"accepted": True, "validationVerdict": "supported"}
        response = {"error": "INFERENCE_UNAVAILABLE", "provider": "cloudflare", "diagnostics": {"generationCalls": [rejected]}}
        validation = _harness.candidate_validation(response)
        self.assertTrue(validation["validatorRejectedCandidates"])
        self.assertEqual(validation["rejectedCandidates"], [rejected])
        self.assertEqual(_harness.classify_failure(["reply is too short"], response, 1, 200), "VALIDATION")
        self.assertEqual(_harness.failure_classes(["reply is too short"], response, 16, 503), ["INFRASTRUCTURE", "LATENCY"])
        self.assertEqual(_harness.failure_classes(["reply is too short"], response, 16, 200), ["LATENCY", "VALIDATION"])
        for container in ["agent", "agentMeta", "diagnostics"]:
            with self.subTest(container=container):
                repaired = {container: {"generationCalls": [rejected, accepted]}}
                self.assertTrue(_harness.candidate_validation(repaired)["validatorRejectedCandidates"])
                self.assertEqual(_harness.failure_classes([], repaired, 1, 200), [])
        self.assertFalse(_harness.candidate_validation({"generationCalls": [accepted]})["validatorRejectedCandidates"])
        self.assertIsNone(_harness.candidate_validation({})["validatorRejectedCandidates"])
        self.assertIsNone(_harness.candidate_validation({"generationCalls": [{"accepted": False, "error": "timeout"}]})["validatorRejectedCandidates"])

    def test_output_paths_are_portable_unique_and_distinct(self):
        first = _harness.output_paths()
        second = _harness.output_paths()
        self.assertEqual(len(set(first + second)), 4)
        self.assertTrue(all(os.path.dirname(path) == os.path.abspath(tempfile.gettempdir()) for path in first + second))
        with self.assertRaises(ValueError):
            _harness.output_paths("same.json", "same.json")

    def test_existing_output_is_never_overwritten_and_precedes_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = os.path.join(directory, "summary.json")
            diagnostics = os.path.join(directory, "diagnostics.json")
            for existing in [summary, diagnostics]:
                with self.subTest(existing=existing):
                    with open(existing, "w", encoding="utf-8") as handle:
                        handle.write("original")
                    with patch.object(_harness, "send_message") as send, self.assertRaises(FileExistsError):
                        _harness.run("http://unused", [], False, 0, summary_output=summary, diagnostics_output=diagnostics)
                    send.assert_not_called()
                    with open(existing, encoding="utf-8") as handle:
                        self.assertEqual(handle.read(), "original")
                    for path in [summary, diagnostics]:
                        if os.path.exists(path):
                            os.remove(path)

    def test_http_failure_cannot_pass_even_with_semantically_valid_reply(self):
        payload = {"reply": "COBOL", "provider": "cloudflare"}
        with tempfile.TemporaryDirectory() as directory:
            summary = os.path.join(directory, "summary.json")
            diagnostics = os.path.join(directory, "diagnostics.json")
            with patch.object(_harness.urllib.request, "urlopen", return_value=self.http_response(payload, 503)), redirect_stdout(io.StringIO()):
                code = _harness.run("http://unused", [("test", ["say cobol"])], False, 0, summary_output=summary, diagnostics_output=diagnostics)
            with open(summary, encoding="utf-8") as handle:
                result = json.load(handle)
        self.assertEqual(code, 1)
        self.assertEqual(result["turnPasses"], 0)
        self.assertEqual(result["results"][0]["turns"][0]["failureClasses"], ["INFRASTRUCTURE"])

    def test_json_http_errors_skip_semantics_and_preserve_history(self):
        for status, label, reply in [(429, "RATE_LIMIT", "Too many requests. Please try again later."), (502, "INFRASTRUCTURE", "Upstream service unavailable.")]:
            for latency in [1, 16]:
                with self.subTest(status=status, latency=latency), tempfile.TemporaryDirectory() as directory:
                    payload = {"reply": reply, "error": "request_failed"}
                    body = json.dumps(payload).encode("utf-8")
                    error = _harness.urllib.error.HTTPError("http://unused", status, "failure", {}, io.BytesIO(body))
                    summary = os.path.join(directory, "summary.json")
                    diagnostics = os.path.join(directory, "diagnostics.json")
                    with patch.object(_harness.urllib.request, "urlopen", side_effect=[error, self.http_response({"reply": "COBOL", "provider": "cloudflare"})]) as send, patch.object(_harness, "check_reply", wraps=_harness.check_reply) as check, patch.object(_harness.time, "monotonic", side_effect=[0, latency, 20, 21]), redirect_stdout(io.StringIO()):
                        code = _harness.run("http://unused", [("test", ["Tell me about ProjectHub", "say cobol"])], False, 0, summary_output=summary, diagnostics_output=diagnostics)
                    with open(summary, encoding="utf-8") as handle:
                        result = json.load(handle)
                    with open(diagnostics, encoding="utf-8") as handle:
                        turns = json.load(handle)
                    self.assertEqual(code, 1)
                    self.assertEqual(result["turnPasses"], 1)
                    self.assertEqual(check.call_count, 1)
                    self.assertEqual(check.call_args.args[0], "say cobol")
                    self.assertEqual(turns[0]["failureClasses"], [label] + (["LATENCY"] if latency > 15 else []))
                    self.assertEqual(turns[0]["issues"], [f"HTTP status {status}"] + (["latency 16.00s exceeds 15s"] if latency > 15 else []))
                    self.assertFalse(turns[0]["passed"])
                    self.assertEqual(turns[0]["httpStatus"], status)
                    self.assertEqual(turns[0]["rawBody"], body.decode("utf-8"))
                    self.assertEqual(turns[0]["response"], payload)
                    self.assertEqual(turns[0]["reply"], reply)
                    request = json.loads(send.call_args_list[1].args[0].data)
                    self.assertEqual(request["history"], [{"user": "Tell me about ProjectHub", "assistant": reply}])
                    self.assertEqual(turns[1]["requestHistory"], request["history"])

    def test_validation_observation_requires_attestation_not_acceptance_alone(self):
        validated = {"accepted": True, "validationVerdict": "supported", "validationReasons": []}
        result = _harness.candidate_validation({"generationCalls": [validated]})
        self.assertTrue(result["validationObserved"])
        self.assertFalse(result["validatorRejectedCandidates"])
        accepted_only = {"accepted": True, "validationVerdict": None, "validationReasons": []}
        result = _harness.candidate_validation({"generationCalls": [accepted_only]})
        self.assertFalse(result["validationObserved"])
        self.assertIsNone(result["validatorRejectedCandidates"])

    def test_diagnostics_are_flushed_before_next_turn(self):
        payload = {"reply": "COBOL", "provider": "cloudflare"}
        with tempfile.TemporaryDirectory() as directory:
            summary = os.path.join(directory, "summary.json")
            diagnostics = os.path.join(directory, "diagnostics.json")
            with patch.object(_harness.urllib.request, "urlopen", side_effect=[self.http_response(payload), KeyboardInterrupt()]), redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
                _harness.run("http://unused", [("test", ["say cobol", "say cobol"])], False, 0, summary_output=summary, diagnostics_output=diagnostics)
            with open(diagnostics, encoding="utf-8") as handle:
                turns = json.load(handle)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["reply"], "COBOL")

    def test_run_preserves_failed_context_cooldown_and_complete_diagnostics(self):
        payload = {"reply": "COBOL", "provider": "cloudflare", "agentEvents": [{"rawAnswer": "z" * 2000}], "newTraceField": {"complete": "y" * 3000}}
        limited_payload = {"reply": "COBOL " * 300, "provider": "cloudflare", "diagnostics": {"generationCalls": []}}
        limited = _harness.urllib.error.HTTPError("http://unused", 429, "limited", {"Retry-After": "5"}, io.BytesIO(json.dumps(limited_payload).encode()))
        responses = [self.http_response(payload), limited, _harness.urllib.error.URLError("offline"), self.http_response(payload), self.http_response(payload)]
        selected = [("sequence", ["say cobol"] * 4), ("next scenario", ["say cobol"])]
        with tempfile.TemporaryDirectory() as directory:
            summary = os.path.join(directory, "summary.json")
            diagnostics = os.path.join(directory, "diagnostics.json")
            with patch.object(_harness.urllib.request, "urlopen", side_effect=responses) as send, patch.object(_harness.time, "sleep") as sleep, patch.object(_harness.time, "monotonic", side_effect=range(10)), redirect_stdout(io.StringIO()):
                code = _harness.run("http://unused", selected, False, 5, scenario_cooldown=5, summary_output=summary, diagnostics_output=diagnostics)
            with open(summary, encoding="utf-8") as handle:
                result = json.load(handle)
            with open(diagnostics, encoding="utf-8") as handle:
                turns = json.load(handle)
        self.assertEqual(code, 1)
        self.assertEqual(result["turns"], 5)
        self.assertEqual(result["turnPasses"], 3)
        self.assertEqual(result["conversationPasses"], 1)
        self.assertEqual(result["failureClassCounts"]["RATE_LIMIT"], 1)
        self.assertEqual(result["failureClassCounts"]["INFRASTRUCTURE"], 1)
        self.assertEqual(send.call_count, 5)
        self.assertEqual(sleep.call_args_list, [call(5)] * 5)
        requests = [json.loads(item.args[0].data) for item in send.call_args_list]
        self.assertEqual(len({item["sessionId"] for item in requests[:4]}), 1)
        self.assertNotEqual(requests[3]["sessionId"], requests[4]["sessionId"])
        self.assertEqual(requests[2]["history"][-1]["assistant"], limited_payload["reply"])
        self.assertEqual(requests[3]["history"], [{"user": "say cobol", "assistant": "COBOL"}, {"user": "say cobol", "assistant": limited_payload["reply"]}, {"user": "say cobol", "assistant": ""}])
        self.assertEqual(requests[4]["history"], [])
        self.assertEqual(turns[1]["httpStatus"], 429)
        self.assertEqual(turns[1]["reply"], limited_payload["reply"])
        self.assertEqual(turns[0]["response"], payload)
        self.assertEqual(turns[3]["requestHistory"], requests[3]["history"])
        self.assertEqual(turns[2]["failureClass"], "INFRASTRUCTURE")
        self.assertFalse(turns[2]["passed"])


if __name__ == "__main__":
    ok = run_tests()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(QualificationInstrumentationTests)
    instrumentation_ok = unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    sys.exit(0 if ok and instrumentation_ok else 1)

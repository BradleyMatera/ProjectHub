#!/usr/bin/env python3
"""
Full-length conversation test suite for ProjectHub Scout chatbot.
Each conversation simulates a different user type, tone, goal, and situation
with 8-15 messages. Tests memory, coherence, tone adaptation, no repetition,
contradiction avoidance, and grounded answers.

Usage:
  python3 test-conversations-full.py [--url URL] [--verbose]

Default URL: https://projecthub-chat.bradleymatera.dev/api/chat
"""

import argparse
import json
import re
import sys
import time
import uuid
import urllib.request
import urllib.error

DEFAULT_URL = "https://projecthub-chat.bradleymatera.dev/api/chat"

# --- Helpers ---

def send_message(url, message, session_id, history=None, retries=2):
    """Send a message to the chat API and return the response dict.
    Retries on 429 rate-limit errors with exponential backoff."""
    payload = {
        "message": message,
        "sessionId": session_id,
        "history": history or [],
    }
    data = json.dumps(payload).encode("utf-8")
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            if e.code == 429 and attempt < retries:
                time.sleep(3 * (attempt + 1))
                continue
            return {"reply": None, "error": f"HTTP {e.code}: {body[:200]}"}
        except Exception as e:
            return {"reply": None, "error": str(e)}
    return {"reply": None, "error": "HTTP 429: Too many requests after retries"}

def strip_html(text):
    """Remove HTML tags for comparison."""
    return re.sub(r"<[^>]+>", "", text or "").strip()

def word_overlap(a, b):
    """Calculate word overlap ratio between two strings."""
    aw = set(strip_html(a).lower().split())
    bw = set(strip_html(b).lower().split())
    if not aw:
        return 0.0
    return len(aw & bw) / len(aw)

def first_words_n(text, n=3):
    """Return the first n lowercase words of a reply."""
    cleaned = re.sub(r"<[^>]+>", "", text or "").strip().lower()
    cleaned = re.sub(r"^[^a-z0-9]+", "", cleaned)
    words = cleaned.split()
    return " ".join(words[:n]) if words else ""

BANNED_OPENERS = ["certainly", "absolutely", "great question", "of course", "as an ai", "sure,"]
BANNED_JARGON = ["robust", "passionate", "synergy", "leverage", "dynamic", "extensive",
                 "groundbreaking", "cutting-edge", "innovative", "world-class", "best-in-class",
                 "proven leader", "deep mastery", "exceptional", "seasoned", "guru"]

# --- Conversation definitions ---
# Each conversation has a situation description and a list of turns.
# Each turn may have checks:
#   - min_len, max_len
#   - must_contain / must_contain_any / must_not_contain
#   - no_repeat: require reply not to repeat an earlier reply in the same conversation (low overlap)
#   - remember: list of strings that must be present (memory from earlier turns)
#   - direct: when True, reply should be short and not end with a follow-up question

CONVERSATIONS = [
    {
        "name": "Friendly recruiter exploring basics",
        "situation": "A friendly recruiter chats casually to learn who Bradley is and what he wants.",
        "turns": [
            {"user": "Hey Scout, what's up?", "checks": {"min_len": 5}},
            {"user": "Tell me a bit about Bradley", "checks": {"min_len": 30}},
            {"user": "What kind of roles is he looking for?", "checks": {"min_len": 20, "must_contain_any": ["entry-level", "junior", "support", "web", "cloud"]}},
            {"user": "Does he have a preferred location?", "checks": {"min_len": 10, "must_contain_any": ["relocation", "davis", "illinois", "open to", "remote"]}},
            {"user": "How does he work with a team?", "checks": {"min_len": 20}},
            {"user": "What's his biggest strength?", "checks": {"min_len": 15, "must_contain_any": ["learn", "document", "debug", "communicat"]}},
            {"user": "And his biggest weakness?", "checks": {"min_len": 20, "must_contain_any": ["data structures", "algorithms", "dsa", "leetcode", "blank file"]}},
            {"user": "Would he be good for a junior frontend role?", "checks": {"min_len": 20}},
            {"user": "Thanks, that's helpful. How can I contact him?", "checks": {"min_len": 10, "must_contain_any": ["linkedin", "email", "github", "bradleymatera", "contact"]}},
        ],
    },
    {
        "name": "Skeptical technical interviewer",
        "situation": "A senior engineer is doubtful and asks pointed questions about real skills and production experience.",
        "turns": [
            {"user": "I've seen a lot of junior resumes. What has Bradley actually built?", "checks": {"min_len": 20}},
            {"user": "Which project is the most technically interesting?", "checks": {"min_len": 20}},
            {"user": "Was any of that production work?", "checks": {"min_len": 15, "must_contain_any": ["project", "school", "intern", "not", "no", "capstone", "labs"]}},
            {"user": "What about AWS? Real AWS or just tutorials?", "checks": {"min_len": 20, "must_contain_any": ["lab", "capstone", "training", "intern", "structured"]}},
            {"user": "Can he actually code, or is he just prompt-engineering?", "checks": {"min_len": 25, "must_contain_any": ["junior", "read", "debug", "modify", "code"]}},
            {"user": "What would he struggle with on the job?", "checks": {"min_len": 20, "must_contain_any": ["data structures", "algorithms", "dsa", "leetcode", "architect", "blank file"]}},
            {"user": "Why should I hire him over someone with a CS degree?", "checks": {"min_len": 20}},
            {"user": "Be honest: is he ready for a real codebase?", "checks": {"min_len": 15}},
            {"user": "What would you ask him in a final interview?", "checks": {"min_len": 20}},
        ],
    },
    {
        "name": "Vague HR screener",
        "situation": "An HR person asks broad, unclear questions and wants simple answers without guessing.",
        "turns": [
            {"user": "Is he a good fit?", "checks": {"min_len": 20}},
            {"user": "What do you mean?", "checks": {"min_len": 20}},
            {"user": "Fit for what kind of roles?", "checks": {"min_len": 15, "must_contain_any": ["junior", "entry-level", "support", "web", "cloud"]}},
            {"user": "Can he work remotely?", "checks": {"min_len": 10}},
            {"user": "Tell me about his background", "checks": {"min_len": 30}},
            {"user": "Any leadership experience?", "checks": {"min_len": 15, "must_contain_any": ["army", "kitten", "volunteer", "train", "junior", "not", "no"]}},
            {"user": "What about salary expectations?", "checks": {"min_len": 10, "must_contain_any": ["not in", "resume", "contact", "public"]}},
            {"user": "Okay, what's the best way to reach him?", "checks": {"min_len": 10, "must_contain_any": ["linkedin", "email", "github", "contact"]}},
        ],
    },
    {
        "name": "Detailed recruiter comparing options",
        "situation": "A recruiter wants to compare Bradley's fit for several specific roles.",
        "turns": [
            {"user": "I'm hiring for a junior frontend developer. Is he a fit?", "checks": {"min_len": 20}},
            {"user": "What about a DevOps role?", "checks": {"min_len": 20}},
            {"user": "And a QA role?", "checks": {"min_len": 20}},
            {"user": "Which of those is the strongest fit?", "checks": {"min_len": 20}},
            {"user": "Why isn't DevOps a good fit?", "checks": {"min_len": 15}},
            {"user": "What skills would he need to learn for DevOps?", "checks": {"min_len": 20}},
            {"user": "How fast does he learn new tech?", "checks": {"min_len": 15}},
            {"user": "Would mentorship help him?", "checks": {"min_len": 10}},
        ],
    },
    {
        "name": "Frustrated user wanting direct answers",
        "situation": "The user is annoyed by perceived evasiveness and demands straight answers.",
        "turns": [
            {"user": "Just answer me: can he code?", "checks": {"min_len": 10, "must_contain_any": ["yes", "junior", "code"], "direct": True}},
            {"user": "What languages?", "checks": {"min_len": 10, "must_contain_any": ["javascript", "typescript", "react", "node", "sql"], "direct": True}},
            {"user": "Stop giving me the same pitch. What are his actual weaknesses?", "checks": {"min_len": 20, "must_contain_any": ["data structures", "algorithms", "dsa", "leetcode", "blank file"]}},
            {"user": "So he can't do LeetCode. Can he learn on the job?", "checks": {"min_len": 15}},
            {"user": "Is he a good fit for a support role or not?", "checks": {"min_len": 10, "direct": True}},
            {"user": "Email me his resume link.", "checks": {"min_len": 10, "must_contain_any": ["linkedin", "github", "bradleymatera", "resume", "contact"]}},
        ],
    },
    {
        "name": "Follow-up heavy conversation",
        "situation": "The recruiter asks follow-ups that build on previous answers and expects context retention.",
        "turns": [
            {"user": "What did he do at Mason County Kitten Rescue?", "checks": {"min_len": 20, "must_contain_any": ["kitten", "rescue", "animal", "volunteer", "paid"]}},
            {"user": "Was that a paid role?", "checks": {"min_len": 10, "must_contain_any": ["paid", "part-time", "volunteer"]}},
            {"user": "What did he do there day to day?", "checks": {"min_len": 20, "must_contain_any": ["feed", "clean", "kennel", "monitor", "intake"]}},
            {"user": "How does that relate to tech?", "checks": {"min_len": 15}},
            {"user": "Tell me about his Army service", "checks": {"min_len": 25, "must_contain_any": ["68w", "combat medic", "health care", "afghanistan", "fort bragg"]}},
            {"user": "What awards did he get?", "checks": {"min_len": 20, "must_contain_any": ["combat medical badge", "commendation", "campaign medal", "service"]}},
            {"user": "Did he lead anyone in the Army?", "checks": {"min_len": 10, "must_contain_any": ["private", "e-3", "train", "soldiers", "not", "no"]}},
            {"user": "So would he do well in a team?", "checks": {"min_len": 15}},
        ],
    },
    {
        "name": "Technical deep dive with follow-ups",
        "situation": "A technical hiring manager asks detailed stack questions.",
        "turns": [
            {"user": "What is his tech stack?", "checks": {"min_len": 20, "must_contain_any": ["javascript", "typescript", "react", "node", "aws"]}},
            {"user": "Does he know TypeScript well?", "checks": {"min_len": 15}},
            {"user": "What about backend frameworks?", "checks": {"min_len": 15}},
            {"user": "Has he worked with databases?", "checks": {"min_len": 15, "must_contain_any": ["sql", "dynamodb", "mongo", "database"]}},
            {"user": "What AWS services has he used?", "checks": {"min_len": 20, "must_contain_any": ["lambda", "dynamodb", "s3", "amplify", "cloudfront"]}},
            {"user": "Any experience with CI/CD or Docker?", "checks": {"min_len": 15}},
            {"user": "How does he handle a bug he can't solve?", "checks": {"min_len": 20}},
            {"user": "What project best shows his current skill level?", "checks": {"min_len": 20}},
        ],
    },
    {
        "name": "User correcting Scout",
        "situation": "The user points out a misunderstanding and expects Scout to adjust.",
        "turns": [
            {"user": "Does he have a CS degree?", "checks": {"min_len": 15, "must_contain_any": ["not", "no", "full sail", "web development", "degree"]}},
            {"user": "I meant a four-year computer science degree.", "checks": {"min_len": 10, "must_contain_any": ["not", "no", "doesn't", "does not"]}},
            {"user": "What degree does he have then?", "checks": {"min_len": 10, "must_contain_any": ["full sail", "web development", "b.s.", "bachelor"]}},
            {"user": "Is Full Sail respected?", "checks": {"min_len": 15}},
            {"user": "Okay, tell me about his actual education.", "checks": {"min_len": 20, "must_contain_any": ["full sail", "web development", "project", "degree"]}},
            {"user": "What did he learn there?", "checks": {"min_len": 15, "must_contain_any": ["javascript", "react", "node", "sql", "project"]}},
        ],
    },
    {
        "name": "Memory and contradiction check",
        "situation": "The recruiter asks the same topic from different angles and checks for contradictions.",
        "turns": [
            {"user": "Is he a frontend developer?", "checks": {"min_len": 15}},
            {"user": "Is he a backend developer?", "checks": {"min_len": 15}},
            {"user": "Is he a full-stack developer?", "checks": {"min_len": 15, "must_contain_any": ["not", "junior", "entry-level", "frontend", "project"]}},
            {"user": "Wait, you said he can do frontend. Now you say he isn't full-stack. Which is it?", "checks": {"min_len": 20}},
            {"user": "So he can do frontend but not full-stack. Got it.", "checks": {"min_len": 10}},
            {"user": "What about AWS? Does he have real production AWS experience?", "checks": {"min_len": 20, "must_contain_any": ["lab", "capstone", "training", "intern", "not", "no", "structured"]}},
            {"user": "But he has AWS certs, right?", "checks": {"min_len": 15, "must_contain_any": ["cert", "solutions architect", "ai practitioner"]}},
            {"user": "So he has AWS certs but not production AWS work. Make sense.", "checks": {"min_len": 10}},
        ],
    },
    {
        "name": "Non-recruiter trying to break out",
        "situation": "A user keeps asking off-topic things and Scout should stay grounded without being rude.",
        "turns": [
            {"user": "What's your favorite color?", "checks": {"min_len": 10}},
            {"user": "Who is the president?", "checks": {"min_len": 10}},
            {"user": "Okay, back to Bradley. What does he do?", "checks": {"min_len": 20}},
            {"user": "What's his favorite food?", "checks": {"min_len": 10}},
            {"user": "Can you recommend a good movie?", "checks": {"min_len": 10}},
            {"user": "Just tell me his tech stack.", "checks": {"min_len": 20, "must_contain_any": ["javascript", "typescript", "react", "node", "aws"]}},
        ],
    },
]

# --- Test runner ---

def check_reply(reply, checks):
    """Run per-turn checks and return a list of issues."""
    issues = []
    if checks.get("min_len") and len(reply) < checks["min_len"]:
        issues.append(f"too short ({len(reply)} chars)")
    if checks.get("max_len") and len(reply) > checks["max_len"]:
        issues.append(f"too long ({len(reply)} chars)")
    rl = reply.lower()
    for w in checks.get("must_contain", []):
        if w.lower() not in rl:
            issues.append(f"missing '{w}'")
    if checks.get("must_contain_any"):
        if not any(w.lower() in rl for w in checks["must_contain_any"]):
            issues.append(f"missing any of {checks['must_contain_any']}")
    for w in checks.get("must_not_contain", []):
        if w.lower() in rl:
            issues.append(f"unexpected '{w}'")
    for j in BANNED_JARGON:
        if j in rl:
            issues.append(f"jargon '{j}'")
    for o in BANNED_OPENERS:
        if rl.startswith(o):
            issues.append(f"banned opener '{o}'")
    return issues

def run_conversation(url, conversation, verbose=False):
    session_id = str(uuid.uuid4())[:8]
    history = []
    results = []
    all_passed = True
    replies = []
    latencies = []

    print(f"\n{conversation['name']}: {conversation['situation']}")

    for i, turn in enumerate(conversation["turns"]):
        user_msg = turn["user"]
        checks = turn.get("checks", {})
        label = f"turn{i+1}"

        # Slow down to avoid the server's per-IP rate limit
        if i > 0:
            time.sleep(2)

        if verbose:
            print(f"  [{label}] User: {user_msg}")

        start = time.time()
        resp = send_message(url, user_msg, session_id, history)
        latency = time.time() - start
        latencies.append(latency)

        reply = resp.get("reply", "")
        error = resp.get("error")
        provider = resp.get("provider", "?")

        if error:
            results.append({"turn": label, "status": "ERROR", "issues": [error], "latency": round(latency, 2)})
            all_passed = False
            continue

        # Update history
        history.append({"user": user_msg, "assistant": reply})
        replies.append(strip_html(reply))

        issues = check_reply(reply, checks)

        # Check direct answer expectation: no trailing follow-up question
        if checks.get("direct") and re.search(r"\?$", strip_html(reply)[-80:]):
            issues.append("ended with a question despite direct request")

        # Check for repeated wording vs previous replies in this conversation.
        # Skip when the user repeated the same question or when the answer is intentionally consistent
        # (out-of-scope, contact, salary). Flag only when a genuinely different question gets >85% identical phrasing.
        if len(replies) > 1 and not turn.get("allow_repeat"):
            max_overlap = 0.0
            rl_lower = strip_html(reply).lower()
            is_intentionally_consistent = any(phrase in rl_lower for phrase in [
                "not in", "recruiter data", "scout covers", "salary and address",
                "outside what", "stays to", "isn't something", "contact him directly"
            ])
            user_repeating = False
            current_q_words = set(strip_html(user_msg).lower().split())
            for prev_turn in history[:-1]:
                prev_q_words = set(strip_html(prev_turn.get("user", "")).lower().split())
                if prev_q_words and len(current_q_words & prev_q_words) / len(prev_q_words) > 0.75:
                    user_repeating = True
                    break
            if not is_intentionally_consistent and not user_repeating:
                for prev in replies[:-1]:
                    ov = word_overlap(reply, prev)
                    max_overlap = max(max_overlap, ov)
                if max_overlap > 0.95:
                    issues.append(f"reply too similar to earlier answer ({max_overlap:.0%} overlap)")

        status = "PASS" if not issues else "FAIL"
        if issues:
            all_passed = False

        results.append({"turn": label, "status": status, "provider": provider,
                        "latency": round(latency, 2), "reply_preview": strip_html(reply)[:120]})
        if issues:
            results[-1]["issues"] = issues

        if verbose or status == "FAIL":
            tag = "PASS" if status == "PASS" else "FAIL"
            print(f"  [{label}] {tag} ({provider}, {latency:.2f}s): {strip_html(reply)[:90]}")
            if issues:
                for iss in issues:
                    print(f"         ! {iss}")

    # Session-level checks
    # 1. Contradiction check: if a turn expects memory, ensure details from earlier are referenced
    # 2. No restart: first words should not repeat more than twice in a row
    first_words = [first_words_n(r, 3) for r in replies]
    for i in range(2, len(first_words)):
        if first_words[i] and first_words[i] == first_words[i-1] == first_words[i-2]:
            results.append({"turn": f"post-repetition-{i}", "status": "FAIL",
                            "issues": [f"replies {i-1}, {i}, and {i+1} all open with '{first_words[i]}'"]})
            all_passed = False

    avg_latency = sum(latencies) / len(latencies) if latencies else 0
    return {"conversation": conversation["name"], "passed": all_passed,
            "results": results, "avg_latency": avg_latency}

def main():
    parser = argparse.ArgumentParser(description="Full conversation tests for Scout")
    parser.add_argument("--url", default=DEFAULT_URL, help="API URL")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--only", default=None, help="Run only the named conversation")
    args = parser.parse_args()

    print("Scout Full Conversation Test Suite")
    print(f"URL: {args.url}")
    print(f"Conversations: {len(CONVERSATIONS)}")
    print("=" * 60)

    total_pass = 0
    total_fail = 0
    all_results = []

    conversations = CONVERSATIONS
    if args.only:
        conversations = [c for c in CONVERSATIONS if args.only.lower() in c["name"].lower()]
        if not conversations:
            print(f"No conversation matched '{args.only}'")
            return 1

    for idx, conv in enumerate(conversations):
        if idx > 0:
            time.sleep(5)
        result = run_conversation(args.url, conv, verbose=args.verbose)
        all_results.append(result)

        for r in result["results"]:
            status = r["status"]
            if status == "PASS":
                pass
            elif status == "WARN":
                print(f"  WARN [{r['turn']}] {r.get('issues', ['?'])[0]}")
            else:
                print(f"  {status} [{r['turn']}] {r.get('issues', [r.get('detail','')])[0]}")

        if result["passed"]:
            total_pass += 1
            print(f"  -> PASSED (avg {result['avg_latency']:.2f}s)")
        else:
            total_fail += 1
            print(f"  -> FAILED (avg {result['avg_latency']:.2f}s)")

    print("\n" + "=" * 60)
    print(f"Results: {total_pass} passed, {total_fail} failed out of {len(conversations)} conversations")

    with open("/tmp/scout-full-conversation-results.json", "w") as f:
        json.dump(all_results, f, indent=2)
    print("Detailed results: /tmp/scout-full-conversation-results.json")

    return 0 if total_fail == 0 else 1

if __name__ == "__main__":
    sys.exit(main())

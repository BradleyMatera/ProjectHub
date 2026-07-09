# Deploy Gemini Recruiter Chat

This guide covers deploying the new Gemini-powered recruiter chat function.

## Architecture

```
bradleymatera.dev/recruiter
↓
Netlify Function: /.netlify/functions/recruiter-chat
↓
Fetch: recruiter-knowledge.json from GitHub
↓
Call Gemini Flash free tier
↓
Return answer
```

## Prerequisites

1. **Netlify Pro** account (you already have this)
2. **Gemini API Key** from Google AI Studio
   - Go to https://makersuite.google.com/app/apikey
   - Create a new key
   - Copy it for the next step

## Deployment Steps

### 1. Set Environment Variables in Netlify

Go to your Netlify site dashboard → Site settings → Environment variables:

```
GEMINI_API_KEY = your-key-here
GEMINI_MODEL = gemini-1.5-flash-latest  (optional, this is the default)
ALLOWED_ORIGINS = https://bradleymatera.dev,https://www.bradleymatera.dev,https://bradleymatera.github.io
```

### 2. Deploy the Function

The function file is at `netlify/functions/recruiter-chat.js`.

Push to your Netlify-connected repo (or drag-and-drop deploy):

```bash
git push origin master
```

Netlify will auto-deploy the function on the next build.

### 3. Verify the Endpoint

Test with curl:

```bash
curl -X POST https://bradleymatera.dev/.netlify/functions/recruiter-chat \
  -H "Content-Type: application/json" \
  -d '{"message": "what is bradleys strongest skill?"}'
```

Expected: A natural, concise answer about Bradley's skills.

### 4. Test the Frontend

Visit https://bradleymatera.dev/recruiter and ask a question in the chat widget.

The widget will automatically call `/.netlify/functions/recruiter-chat` when on the bradleymatera.dev domain.

## How It Works

1. **Frontend** (`logic.js`): Detects `bradleymatera.dev` domain and calls `/.netlify/functions/recruiter-chat`
2. **Netlify Function** (`recruiter-chat.js`):
   - Fetches `recruiter-knowledge.json` from GitHub (cached 5 minutes)
   - Builds a prompt with conversation quality standards from the test suite
   - Calls Gemini Flash with safety settings and 150 token limit
   - Validates the reply against anti-slop rules
   - Returns cleaned, natural answer
3. **Fallback**: If Gemini fails, returns a coherent fallback instead of breaking

## Fallback Architecture

The GCP Ollama VM is still running as a fallback:

- **Primary**: `/.netlify/functions/recruiter-chat` (Gemini, fast, smart)
- **Fallback**: `https://projecthub-chat.bradleymatera.dev/api/chat` (Ollama, free, demo)

To use the fallback manually, set in browser console:
```javascript
window.__PROJECTHUB_CHAT_API__ = "https://projecthub-chat.bradleymatera.dev/api/chat";
```

## Cost

- **Netlify Pro**: Already paid for
- **Gemini Flash free tier**: 1,500 requests/day, 1M tokens/minute
- **GitHub raw fetch**: Free

Expected cost: **$0** for normal recruiter chat usage.

## Monitoring

Watch Netlify function logs:
1. Netlify dashboard → Functions → recruiter-chat
2. Check for errors, timeouts, or validation failures

Common issues:
- `GEMINI_API_KEY not configured` → Add env var
- `Knowledge file unavailable` → Check GitHub raw URL is accessible
- Reply too generic → Check anti-slop validation isn't too strict

## Updating Knowledge

Edit `data/recruiter-knowledge.json` in this repo, commit, and push.

The function fetches from GitHub raw with a 5-minute cache, so changes appear within 5 minutes.

## Test Suite Integration

The function uses patterns from `conversational_ai_test_suite_projecthub.pdf`:

- Conversation quality standards (grounding, naturalness, brevity)
- Anti-slop word/phrase filtering
- Typos and slang normalization
- Safety settings for harmful content

## Troubleshooting

### Function not found
Check that `netlify/functions/recruiter-chat.js` exists in your deployed repo.

### CORS errors
Verify `ALLOWED_ORIGINS` includes your domain.

### Slow responses
Gemini Flash is typically under 2 seconds. If slow, check Netlify function cold start.

### Generic answers
The cleanGeminiReply validator may be too strict. Check Netlify logs for validation failures.

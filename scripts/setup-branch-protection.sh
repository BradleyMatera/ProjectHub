#!/bin/bash
# setup-branch-protection.sh - Configure branch protection and environments via GitHub API
# Run this manually as Bradley. Requires gh CLI authenticated with admin access.
#
# Usage:
#   gh auth login
#   bash scripts/setup-branch-protection.sh

set -e

REPO="BradleyMatera/ProjectHub"

echo "=== Setting up branch protection for $REPO ==="
echo ""

# --- Protect master ---
echo "Protecting master branch..."
gh api -X PUT "repos/$REPO/branches/master/protection" \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Test and Verify / verify"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
EOF
echo "master protected"
echo ""

# --- Protect develop ---
echo "Protecting develop branch..."
gh api -X PUT "repos/$REPO/branches/develop/protection" \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Test and Verify / verify"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false
}
EOF
echo "develop protected"
echo ""

# --- Create environments ---
echo "Creating staging environment..."
gh api -X PUT "repos/$REPO/environments/staging" \
  --input - << 'EOF'
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
EOF
echo "staging environment created"
echo ""

echo "Creating production environment..."
gh api -X PUT "repos/$REPO/environments/production" \
  --input - << 'EOF'
{
  "deployment_branch_policy": {
    "protected_branches": true
  }
}
EOF
echo "production environment created"
echo ""

echo "=== Setup complete ==="
echo ""
echo "Verify:"
echo "  gh api repos/$REPO/branches/master/protection --jq '.required_status_checks.contexts'"
echo "  gh api repos/$REPO/branches/develop/protection --jq '.required_status_checks.contexts'"
echo "  gh api repos/$REPO/environments --jq '.environments[].name'"
echo ""
echo "NOTE: Add yourself as a required reviewer for the production environment"
echo "  in Settings → Environments → production → Required reviewers."

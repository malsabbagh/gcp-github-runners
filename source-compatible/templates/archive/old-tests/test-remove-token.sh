#!/bin/bash
set -euo pipefail

echo "=== Testing GitHub Runner Remove Token Approach ==="

# Get GitHub PAT
GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" --project="PARITY_INPUT_064")
REPO_OWNER="PARITY_INPUT_010"
REPO_NAME="VeraID"

echo "Testing remove token generation..."

# Generate remove token using GitHub API
remove_token_response=$(curl -s -X POST \
    -H "Authorization: Bearer $GITHUB_PAT" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: github-runner-shutdown-test" \
    "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/remove-token" 2>/dev/null)

echo "Remove token response: $remove_token_response"

# Extract remove token (without jq dependency)
remove_token=$(echo "$remove_token_response" | grep -o '"token":"[^"]*"' | sed 's/"token":"\([^"]*\)"/\1/')

if [ -z "$remove_token" ] || [ "$remove_token" = "null" ]; then
    echo "❌ Invalid remove token received from GitHub"
    exit 1
else
    echo "✅ Remove token obtained successfully: ${remove_token:0:20}..."
fi

echo "Now let's test if config.sh remove would work..."
echo "Command would be: ./config.sh remove --token $remove_token"

echo "=== Test completed ==="

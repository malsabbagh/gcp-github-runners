#!/bin/bash
# Debug script to test GitHub runner setup components manually
# Run this on the VM instance to diagnose startup issues

set -e

echo "=== GitHub Runner Startup Debug Script ==="
echo "Running as user: $(whoami)"
echo "Current directory: $(pwd)"
echo "Date: $(date)"

# Test 1: Basic environment
echo ""
echo "=== Test 1: Environment Check ==="
echo "PATH: $PATH"
echo "Home: $HOME"

# Test 2: gcloud authentication
echo ""
echo "=== Test 2: gcloud Authentication ==="
if gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1 > /dev/null 2>&1; then
    ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1)
    echo "✓ gcloud authenticated as: $ACTIVE_ACCOUNT"
    
    # Show project
    CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)
    echo "Current project: $CURRENT_PROJECT"
else
    echo "❌ No active gcloud authentication"
    echo "Available accounts:"
    gcloud auth list
    exit 1
fi

# Test 3: Metadata access
echo ""
echo "=== Test 3: Metadata Access ==="
MD_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
CURL_OPTS=(-s -H "Metadata-Flavor: Google")

echo "Testing metadata server connectivity..."
if curl -s --connect-timeout 5 -H "Metadata-Flavor: Google" \
   "http://metadata.google.internal/computeMetadata/v1/instance/name"; then
    echo "✓ Metadata server accessible"
    
    # Get repository info from metadata
    REPO_OWNER=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-owner" 2>/dev/null || echo "NOT_SET")
    REPO_NAME=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-name" 2>/dev/null || echo "NOT_SET")
    
    echo "Repository from metadata: $REPO_OWNER/$REPO_NAME"
else
    echo "❌ Cannot access metadata server"
    exit 1
fi

# Get GitHub PAT from Secret Manager
echo ""
echo "Getting GitHub PAT from Secret Manager..."
if GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>&1); then
    if [ -n "$GITHUB_PAT" ]; then
        echo "✓ PAT retrieved: ${GITHUB_PAT:0:10}... (first 10 chars)"
    else
        echo "❌ PAT is empty"
        exit 1
    fi
else
    echo "❌ Failed to get PAT: $GITHUB_PAT"
    exit 1
fi

# Test 5: Network connectivity
echo ""
echo "=== Test 5: Network Connectivity ==="
echo "Testing GitHub API connectivity..."
if curl -s --connect-timeout 10 --max-time 30 -o /dev/null https://api.github.com; then
    echo "✓ GitHub API accessible"
else
    echo "❌ Cannot reach GitHub API"
    exit 1
fi

# Test 6: Repository access (if we have repo info)
if [ "$REPO_OWNER" != "NOT_SET" ] && [ "$REPO_NAME" != "NOT_SET" ] && [ -n "$GITHUB_PAT" ]; then
    echo ""
    echo "Testing repository access: $REPO_OWNER/$REPO_NAME"
    
    # First, test a simple GET without auth to see if the endpoint is reachable
    echo "Testing basic connectivity to repo endpoint..."
    if timeout 10 curl -s --connect-timeout 3 --max-time 5 \
       "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" > /tmp/basic_test.json 2>/dev/null; then
        echo "✓ Basic endpoint reachable"
        echo "Response size: $(wc -c < /tmp/basic_test.json) bytes"
        echo "First 200 chars: $(head -c 200 /tmp/basic_test.json)"
    else
        echo "❌ Cannot reach basic endpoint"
        echo "Trying with verbose output..."
        timeout 10 curl -v --connect-timeout 3 --max-time 5 \
           "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" 2>&1 | head -20
        exit 1
    fi
    
    # Now test with authentication
    echo ""
    echo "Testing with authentication..."
    if timeout 10 curl -s --connect-timeout 3 --max-time 5 \
       -H "Authorization: Bearer $GITHUB_PAT" \
       "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" > /tmp/auth_test.json 2>/dev/null; then
        echo "✓ Authenticated request successful"
        echo "Response size: $(wc -c < /tmp/auth_test.json) bytes"
        
        # Check for error in response
        if grep -q '"message"' /tmp/auth_test.json 2>/dev/null; then
            echo "❌ API returned error:"
            cat /tmp/auth_test.json
            exit 1
        else
            echo "✓ Repository access successful"
        fi
    else
        echo "❌ Authenticated request failed"
        echo "Trying with verbose output..."
        timeout 10 curl -v --connect-timeout 3 --max-time 5 \
           -H "Authorization: Bearer $GITHUB_PAT" \
           "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" 2>&1 | head -20
        exit 1
    fi

    # Test 7: Registration token generation
    echo ""
    echo "Generating registration token..."
    
    if timeout 15 curl -s --connect-timeout 3 --max-time 10 \
       -X POST \
       -H "Authorization: Bearer $GITHUB_PAT" \
       "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/registration-token" > /tmp/token_test.json 2>/dev/null; then
        echo "✓ Registration token request completed"
        echo "Response size: $(wc -c < /tmp/token_test.json) bytes"
        echo "Response: $(cat /tmp/token_test.json)"
        
        # Check for error in response
        if grep -q '"message"' /tmp/token_test.json 2>/dev/null; then
            echo "❌ Token generation failed:"
            cat /tmp/token_test.json
            exit 1
        fi
        
        # Parse token
        if command -v jq >/dev/null 2>&1; then
            RUNNER_TOKEN=$(jq -r '.token' /tmp/token_test.json 2>/dev/null)
            if [ -n "$RUNNER_TOKEN" ] && [ "$RUNNER_TOKEN" != "null" ]; then
                echo "✅ Registration token generated successfully!"
                echo "Token: ${RUNNER_TOKEN:0:20}... (first 20 chars)"
            else
                echo "❌ Failed to parse registration token"
                exit 1
            fi
        else
            echo "⚠ jq not available, cannot parse token"
        fi
    else
        echo "❌ Registration token request failed"
        echo "Trying with verbose output..."
        timeout 15 curl -v --connect-timeout 3 --max-time 10 \
           -X POST \
           -H "Authorization: Bearer $GITHUB_PAT" \
           "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/registration-token" 2>&1 | head -20
        exit 1
    fi
else
    echo ""
    echo "Skipping repository tests (missing repo info or PAT)"
fi

echo ""
echo "🎉 All tests passed! GitHub runner setup should work."

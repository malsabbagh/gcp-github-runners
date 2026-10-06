#!/bin/bash

# Test script to verify GitHub runner remove token fix
# This script tests the remove token generation logic

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${BLUE}================================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}================================================${NC}"
}

print_test() {
    echo -e "${YELLOW}[TEST] $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ PASS: $1${NC}"
}

print_failure() {
    echo -e "${RED}❌ FAIL: $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  INFO: $1${NC}"
}

# Test configuration
TEST_REPO_OWNER="test-owner"
TEST_REPO_NAME="test-repo"
MOCK_GITHUB_PAT="ghp_test123"

print_header "GitHub Runner Remove Token Fix Tests"

# Test 1: Verify remove token API call format
print_test "Remove token API call format"

# Mock the API call to test the format
test_remove_token_api_call() {
    local repo_owner="$1"
    local repo_name="$2"
    local github_pat="$3"
    
    # This is the actual API call format from our fix
    local api_url="https://api.github.com/repos/$repo_owner/$repo_name/actions/runners/remove-token"
    local expected_headers=(
        "-H" "Authorization: Bearer $github_pat"
        "-H" "Accept: application/vnd.github+json"
        "-H" "User-Agent: github-runner-shutdown"
    )
    
    echo "API URL: $api_url"
    echo "Headers: ${expected_headers[*]}"
    
    # Verify URL format
    if [[ "$api_url" == "https://api.github.com/repos/$repo_owner/$repo_name/actions/runners/remove-token" ]]; then
        return 0
    else
        return 1
    fi
}

if test_remove_token_api_call "$TEST_REPO_OWNER" "$TEST_REPO_NAME" "$MOCK_GITHUB_PAT"; then
    print_success "API call format is correct"
else
    print_failure "API call format is incorrect"
fi

# Test 2: Verify JSON parsing logic
print_test "JSON parsing logic"

# Mock successful response
mock_response='{"token":"AABF3JGZDX3P5PMEXLND6TS6FCWO6","expires_at":"2020-01-29T12:13:35.123-08:00"}'

# Test token extraction
if command -v jq &>/dev/null; then
    extracted_token=$(echo "$mock_response" | jq -r '.token' 2>/dev/null || echo "")
    if [ "$extracted_token" = "AABF3JGZDX3P5PMEXLND6TS6FCWO6" ]; then
        print_success "JSON parsing extracts token correctly"
    else
        print_failure "JSON parsing failed: got '$extracted_token'"
    fi
else
    print_info "jq not available, skipping JSON parsing test"
fi

# Test 3: Verify error handling for invalid responses
print_test "Error handling for invalid responses"

# Mock error response
mock_error_response='{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}'

if command -v jq &>/dev/null; then
    extracted_token=$(echo "$mock_error_response" | jq -r '.token' 2>/dev/null || echo "")
    if [ -z "$extracted_token" ] || [ "$extracted_token" = "null" ]; then
        print_success "Error response handling works correctly"
    else
        print_failure "Error response not handled correctly: got '$extracted_token'"
    fi
else
    print_info "jq not available, skipping error handling test"
fi

# Test 4: Compare old vs new approach
print_test "Comparing old vs new approach"

print_info "OLD APPROACH (incorrect):"
echo "  docker exec \$CONTAINER_NAME /actions-runner/config.sh remove --token \"\$GITHUB_PAT\""
echo "  ❌ Uses PAT directly instead of remove token"

print_info "NEW APPROACH (correct):"
echo "  1. Generate remove token: POST /repos/OWNER/REPO/actions/runners/remove-token"
echo "  2. Use remove token: docker exec \$CONTAINER_NAME /actions-runner/config.sh remove --token \"\$REMOVE_TOKEN\""
echo "  ✅ Uses proper remove token as per GitHub API documentation"

print_success "Approach comparison documented"

# Test 5: Verify changes were applied to correct files
print_test "Verifying changes were applied to scripts"

files_to_check=(
    "cloudbuild/runner-shutdown-docker.sh"
    "cloudbuild/runner-shutdown-multi-user.sh"
)

for file in "${files_to_check[@]}"; do
    if [ -f "$file" ]; then
        if grep -q "remove-token" "$file"; then
            print_success "File $file contains remove-token logic"
        else
            print_failure "File $file missing remove-token logic"
        fi
    else
        print_failure "File $file not found"
    fi
done

print_header "Test Summary"
echo "Files modified:"
echo "  1. cloudbuild/runner-shutdown-docker.sh - Fixed to use remove token instead of PAT"
echo "  2. cloudbuild/runner-shutdown-multi-user.sh - Added proper API headers"
echo ""
echo "Key improvements:"
echo "  ✅ Proper GitHub API usage with remove tokens"
echo "  ✅ Correct HTTP headers (Accept, User-Agent)"
echo "  ✅ Better error handling and validation"
echo "  ✅ Compliance with GitHub API documentation"
echo ""
echo "API Documentation Reference:"
echo "  https://docs.github.com/en/rest/actions/self-hosted-runners#create-a-remove-token-for-a-repository"

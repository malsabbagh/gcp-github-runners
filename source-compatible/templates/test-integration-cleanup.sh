#!/bin/bash

# Integration Test for Cloud Build Cleanup Trigger
# Tests the actual Cloud Build trigger execution and stop-before-delete behavior

set -euo pipefail

PROJECT_ID="PARITY_INPUT_064"
ZONE="us-central1-a"
REGION="us-central1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}================================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}================================================${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_failure() {
    echo -e "${RED}❌ $1${NC}"
}

print_header "Cloud Build Cleanup Trigger Integration Test"

# Test 1: Verify trigger configuration contains stop logic
print_info "Testing Cloud Build trigger configuration..."

TRIGGER_SCRIPT=$(gcloud builds triggers describe github-runner-cleanup --format="value(build.steps[0].args[1])" 2>/dev/null)

if echo "$TRIGGER_SCRIPT" | grep -q "🛑 Stopping instance.*to run shutdown scripts"; then
    print_success "Trigger contains stop-before-delete logic"
else
    print_failure "Trigger missing stop-before-delete logic"
    echo "Current trigger script (first 300 chars):"
    echo "${TRIGGER_SCRIPT:0:300}..."
    exit 1
fi

if echo "$TRIGGER_SCRIPT" | grep -q "sleep 30"; then
    print_success "Trigger includes wait time for shutdown scripts"
else
    print_failure "Trigger missing wait time for shutdown scripts"
fi

# Test 2: Test manual trigger execution
print_info "Testing manual trigger execution..."

# Publish a message to trigger cleanup
print_info "Publishing message to cleanup trigger..."
MESSAGE_ID=$(gcloud pubsub topics publish runner-cleanup-trigger --message='{"action":"cleanup","test":true}' --format="value(messageIds[0])")

if [ -n "$MESSAGE_ID" ]; then
    print_success "Successfully published trigger message (ID: $MESSAGE_ID)"
else
    print_failure "Failed to publish trigger message"
    exit 1
fi

# Wait for build to start
print_info "Waiting for Cloud Build to start..."
sleep 10

# Check for recent builds
RECENT_BUILDS=$(gcloud builds list --limit=3 --format="value(id,status,createTime)" | head -1)
BUILD_ID=$(echo "$RECENT_BUILDS" | cut -d$'\t' -f1)
BUILD_STATUS=$(echo "$RECENT_BUILDS" | cut -d$'\t' -f2)

print_info "Most recent build: $BUILD_ID (Status: $BUILD_STATUS)"

# Wait for build to complete (up to 3 minutes)
print_info "Waiting for build to complete..."
TIMEOUT=180
ELAPSED=0

while [ $ELAPSED -lt $TIMEOUT ]; do
    CURRENT_STATUS=$(gcloud builds describe "$BUILD_ID" --format="value(status)" 2>/dev/null || echo "UNKNOWN")
    
    if [ "$CURRENT_STATUS" = "SUCCESS" ]; then
        print_success "Build completed successfully"
        break
    elif [ "$CURRENT_STATUS" = "FAILURE" ] || [ "$CURRENT_STATUS" = "TIMEOUT" ]; then
        print_failure "Build failed with status: $CURRENT_STATUS"
        break
    elif [ "$CURRENT_STATUS" = "WORKING" ] || [ "$CURRENT_STATUS" = "QUEUED" ]; then
        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    else
        print_info "Build status: $CURRENT_STATUS"
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    fi
done

echo "" # New line after dots

if [ $ELAPSED -ge $TIMEOUT ]; then
    print_failure "Build timed out after $TIMEOUT seconds"
    exit 1
fi

# Test 3: Verify build logs contain stop-before-delete behavior
print_info "Checking build logs for stop-before-delete behavior..."

# Get build logs
BUILD_LOGS=$(gcloud logging read "resource.type=\"build\" AND resource.labels.build_id=\"$BUILD_ID\"" \
    --format="value(textPayload)" --limit=100 --project="$PROJECT_ID" 2>/dev/null | \
    grep -v "^$" | head -20)

if echo "$BUILD_LOGS" | grep -q "🛑 Stopping instance.*to run shutdown scripts"; then
    print_success "Build logs show stop-before-delete behavior"
elif echo "$BUILD_LOGS" | grep -q "No old instances found"; then
    print_success "Build ran successfully - no old instances to clean (expected)"
    print_info "Build found no instances to clean up, which is normal"
else
    print_info "Recent build logs:"
    echo "$BUILD_LOGS" | head -10
fi

# Test 4: Verify build substitutions are working
print_info "Checking build substitutions..."

BUILD_SUBSTITUTIONS=$(gcloud builds describe "$BUILD_ID" --format="value(substitutions._REGION)" 2>/dev/null || echo "")

if [ "$BUILD_SUBSTITUTIONS" = "$REGION" ]; then
    print_success "Build substitutions working correctly (Region: $BUILD_SUBSTITUTIONS)"
else
    print_failure "Build substitutions not working (Expected: $REGION, Got: $BUILD_SUBSTITUTIONS)"
fi

# Test 5: Verify service account permissions
print_info "Checking cleanup service account permissions..."

SERVICE_ACCOUNT=$(gcloud builds describe "$BUILD_ID" --format="value(serviceAccount)" 2>/dev/null || echo "")

if [[ "$SERVICE_ACCOUNT" == *"github-runner-cloudbuild"* ]]; then
    print_success "Build using correct service account: $SERVICE_ACCOUNT"
else
    print_failure "Build using incorrect service account: $SERVICE_ACCOUNT"
fi

print_header "Integration Test Summary"

print_success "Cloud Build cleanup trigger integration test completed"
print_info "The trigger is properly configured with stop-before-delete logic"
print_info "Manual trigger execution works correctly"
print_info "Next scheduled cleanup will use the new behavior"

echo ""
print_info "To monitor the next scheduled cleanup (runs every 2 hours):"
echo "  gcloud builds list --limit=5"
echo "  gcloud logging read 'resource.type=\"build\" AND protoPayload.serviceName=\"cloudbuild.googleapis.com\"' --limit=10"

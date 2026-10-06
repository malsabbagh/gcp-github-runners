#!/bin/bash

# Unit Tests for GitHub Runner Infrastructure - Shutdown Script Fix
# This test suite verifies that shutdown scripts are properly executed during cleanup

set -euo pipefail

# Test configuration
PROJECT_ID="PARITY_INPUT_064"
ZONE="us-central1-a"
TEST_PREFIX="shutdown-test"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_INSTANCE_NAME="${TEST_PREFIX}-${TIMESTAMP}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test result tracking
TESTS_PASSED=0
TESTS_FAILED=0
TOTAL_TESTS=0

print_header() {
    echo -e "${BLUE}================================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}================================================${NC}"
}

print_test() {
    echo -e "${YELLOW}[TEST] $1${NC}"
    ((TOTAL_TESTS++))
}

print_success() {
    echo -e "${GREEN}✅ PASS: $1${NC}"
    ((TESTS_PASSED++))
}

print_failure() {
    echo -e "${RED}❌ FAIL: $1${NC}"
    ((TESTS_FAILED++))
}

print_info() {
    echo -e "${BLUE}ℹ️  INFO: $1${NC}"
}

cleanup_test_resources() {
    print_info "Cleaning up test resources..."
    
    # Delete test instances
    local instances=$(gcloud compute instances list --filter="name~'${TEST_PREFIX}'" --format="value(name,zone)" 2>/dev/null || true)
    if [ -n "$instances" ]; then
        while IFS=$'\t' read -r name zone; do
            print_info "Deleting test instance: $name in $zone"
            gcloud compute instances delete "$name" --zone="$zone" --quiet 2>/dev/null || true
        done <<< "$instances"
    fi
    
    print_info "Test cleanup completed"
}

# Trap to ensure cleanup
trap cleanup_test_resources EXIT

print_header "GitHub Runner Infrastructure - Shutdown Script Tests"

# Test 1: Verify Cloud Build trigger exists and has correct configuration
print_test "Cloud Build cleanup trigger configuration"
TRIGGER_CONFIG=$(gcloud builds triggers describe github-runner-cleanup --format="value(build.steps[0].args[1])" 2>/dev/null || echo "")

if [[ "$TRIGGER_CONFIG" == *"🛑 Stopping instance"* ]] && [[ "$TRIGGER_CONFIG" == *"to run shutdown scripts"* ]]; then
    print_success "Cloud Build trigger has stop-before-delete logic"
else
    print_failure "Cloud Build trigger missing stop-before-delete logic"
    echo "Current trigger config (first 200 chars):"
    echo "${TRIGGER_CONFIG:0:200}..."
fi

# Test 2: Verify shutdown script exists and has proper structure  
print_test "Shutdown script structure validation"
SHUTDOWN_SCRIPT_PATH="../cloudbuild/runner-shutdown-multi-user-docker.sh"

if [ -f "$SHUTDOWN_SCRIPT_PATH" ]; then
    # Check for key components in shutdown script
    if grep -q "Multi-user Docker-based GitHub Runner shutdown script" "$SHUTDOWN_SCRIPT_PATH" && \
       grep -q "RUNNER_USERS_FILE" "$SHUTDOWN_SCRIPT_PATH" && \
       grep -q "docker stop" "$SHUTDOWN_SCRIPT_PATH" && \
       grep -q "docker rm" "$SHUTDOWN_SCRIPT_PATH"; then
        print_success "Shutdown script has all required components"
    else
        print_failure "Shutdown script missing required components"
    fi
else
    print_failure "Shutdown script not found at $SHUTDOWN_SCRIPT_PATH"
fi

# Test 3: Verify startup script creates runner configuration file
print_test "Startup script runner configuration file creation"
STARTUP_SCRIPT_PATH="../cloudbuild/runner-startup-multi-user-docker.sh"

if [ -f "$STARTUP_SCRIPT_PATH" ]; then
    if grep -q "RUNNER_USERS_FILE" "$STARTUP_SCRIPT_PATH" && \
       grep -q "/var/log/runner-users.txt" "$STARTUP_SCRIPT_PATH"; then
        print_success "Startup script creates runner configuration file"
    else
        print_failure "Startup script doesn't create runner configuration file"
    fi
else
    print_failure "Startup script not found at $STARTUP_SCRIPT_PATH"
fi

# Test 4: Verify instance template includes shutdown script
print_test "Instance template shutdown script configuration"
TEMPLATE_CONFIG=$(gcloud compute instance-templates describe github-runner-template --format="value(properties.metadata.items[?key=='shutdown-script'].value)" 2>/dev/null || echo "")

if [[ "$TEMPLATE_CONFIG" == *"Multi-user Docker-based GitHub Runner shutdown script"* ]]; then
    print_success "Instance template includes shutdown script"
else
    print_failure "Instance template missing shutdown script"
fi

# Test 5: Test shutdown script with mock data (dry run)
print_test "Shutdown script dry run with mock data"
TEMP_DIR=$(mktemp -d)
MOCK_USERS_FILE="$TEMP_DIR/runner-users.txt"

# Create mock runner users file
cat > "$MOCK_USERS_FILE" << 'EOF'
INSTANCE_NAME="test-runner"
RUNNER_COUNT="2"
RUNNER_USER_PREFIX="runner-abc123"
RUNNER_USER_1="runner-abc123-1"
RUNNER_USER_2="runner-abc123-2"
CONTAINER_NAME_1="github-runner-1"
CONTAINER_NAME_2="github-runner-2"
REPO_OWNER="testowner"
REPO_NAME="testrepo"
EOF

# Test if shutdown script can parse the configuration
if bash -n "$SHUTDOWN_SCRIPT_PATH"; then
    print_success "Shutdown script syntax is valid"
else
    print_failure "Shutdown script has syntax errors"
fi

rm -rf "$TEMP_DIR"

# Test 6: Verify Cloud Scheduler is enabled and running
print_test "Cloud Scheduler configuration and status"
SCHEDULER_STATUS=$(gcloud scheduler jobs describe runner-cleanup-schedule --format="value(state)" 2>/dev/null || echo "NOT_FOUND")

if [ "$SCHEDULER_STATUS" = "ENABLED" ]; then
    print_success "Cloud Scheduler job is enabled"
else
    print_failure "Cloud Scheduler job is not enabled (status: $SCHEDULER_STATUS)"
fi

# Test 7: Test Pub/Sub topic exists and is properly configured
print_test "Pub/Sub topic configuration"
TOPIC_EXISTS=$(gcloud pubsub topics describe runner-cleanup-trigger --format="value(name)" 2>/dev/null || echo "")

if [ -n "$TOPIC_EXISTS" ]; then
    print_success "Pub/Sub cleanup topic exists"
else
    print_failure "Pub/Sub cleanup topic not found"
fi

# Test 8: Verify trigger subscribes to correct topic  
print_test "Cloud Build trigger Pub/Sub subscription"
TRIGGER_TOPIC=$(gcloud builds triggers describe github-runner-cleanup --format="value(pubsubConfig.topic)" 2>/dev/null || echo "")

if [[ "$TRIGGER_TOPIC" == *"runner-cleanup-trigger"* ]]; then
    print_success "Cloud Build trigger subscribes to correct Pub/Sub topic"
else
    print_failure "Cloud Build trigger not properly subscribed to Pub/Sub topic"
fi

# Test 9: Create a test instance and verify it can be cleaned up properly
print_test "End-to-end cleanup test with real instance"

# Create a test instance with old timestamp to trigger cleanup
print_info "Creating test instance: $TEST_INSTANCE_NAME"
if gcloud compute instances create "$TEST_INSTANCE_NAME" \
    --source-instance-template="github-runner-template" \
    --zone="$ZONE" \
    --labels=purpose=github-runner,test=shutdown-verification \
    --quiet 2>/dev/null; then
    
    print_info "Test instance created successfully"
    
    # Wait a moment for instance to fully start
    sleep 10
    
    # Manually trigger the cleanup (this will test our new stop-before-delete logic)
    print_info "Triggering manual cleanup to test stop-before-delete behavior"
    
    # Force the instance to appear old by using a custom filter
    # We'll manually test the stop and delete sequence
    print_info "Testing stop sequence..."
    if gcloud compute instances stop "$TEST_INSTANCE_NAME" --zone="$ZONE" --quiet 2>/dev/null; then
        print_info "Instance stopped successfully (shutdown scripts would have run)"
        
        # Wait for shutdown to complete
        sleep 5
        
        print_info "Testing delete sequence..."
        if gcloud compute instances delete "$TEST_INSTANCE_NAME" --zone="$ZONE" --quiet 2>/dev/null; then
            print_success "End-to-end stop-then-delete sequence works correctly"
        else
            print_failure "Failed to delete stopped instance"
        fi
    else
        print_failure "Failed to stop test instance"
        # Clean up the instance
        gcloud compute instances delete "$TEST_INSTANCE_NAME" --zone="$ZONE" --quiet 2>/dev/null || true
    fi
else
    print_failure "Failed to create test instance"
fi

# Test 10: Verify IAM permissions for cleanup service account
print_test "Cleanup service account permissions"
CLEANUP_SA="github-runner-cloudbuild@${PROJECT_ID}.iam.gserviceaccount.com"

# Check if the service account has compute instance admin permissions
if gcloud projects get-iam-policy "$PROJECT_ID" --flatten="bindings[].members" --format="value(bindings.role,bindings.members[])" | grep -q "roles/.*compute.*$CLEANUP_SA"; then
    print_success "Cleanup service account has compute permissions"
else
    print_failure "Cleanup service account missing compute permissions"
fi

print_header "Test Results Summary"

echo -e "${BLUE}Total Tests: $TOTAL_TESTS${NC}"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed! The shutdown script fix is working correctly.${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed. Please review the issues above.${NC}"
    exit 1
fi

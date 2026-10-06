#!/bin/bash
set -eo pipefail

# Entrypoint for Rust-flavored GitHub Actions runner container
# Expects: GITHUB_PAT, REPO_URL, RUNNER_NAME, RUNNER_LABELS, etc.

# Print system and environment information for debugging
echo "[entrypoint] System Information:"
echo "  OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo "  GLIBC: $(ldd --version | head -n1)"
echo "  Rust: $(rustc --version 2>/dev/null || echo 'Not available')"
echo "  Cargo: $(cargo --version 2>/dev/null || echo 'Not available')"
echo "  Runner: $(whoami) (UID: $(id -u), GID: $(id -g))"
echo ""

# Normalize HOME and set Rust-related dirs to avoid cross-device link issues
export HOME="${HOME:-/home/runner}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export RUSTUP_USE_HARDLINKS=0
export TMPDIR="${TMPDIR:-$RUSTUP_HOME/tmp}"
mkdir -p "$CARGO_HOME" "$RUSTUP_HOME" "$TMPDIR"

echo "[entrypoint] Environment paths:"
echo "  HOME=$HOME"
echo "  CARGO_HOME=$CARGO_HOME"
echo "  RUSTUP_HOME=$RUSTUP_HOME"
echo "  TMPDIR=$TMPDIR"
echo ""

# If no GitHub PAT is provided, just run the command and exit (for testing)
if [[ -z "${GITHUB_PAT:-}" ]]; then
    echo "[entrypoint] No GITHUB_PAT provided - running in test mode"
    if [[ $# -gt 0 ]]; then
        exec "$@"
    else
        echo "[entrypoint] No command provided"
        exit 0
    fi
fi

# Helper: get registration token
get_registration_token() {
  local pat="$GITHUB_PAT"
  local repo_url="$REPO_URL"
  local api_url
  api_url="https://api.github.com/repos/${repo_url#https://github.com/}/actions/runners/registration-token"
  curl -s -X POST -H "Authorization: Bearer $pat" "$api_url" | jq -r .token
}

# Helper: get removal token
get_removal_token() {
  local pat="$GITHUB_PAT"
  local repo_url="$REPO_URL"
  local api_url
  api_url="https://api.github.com/repos/${repo_url#https://github.com/}/actions/runners/remove-token"
  curl -s -X POST -H "Authorization: Bearer $pat" "$api_url" | jq -r .token
}

# Pre-job cleanup to ensure clean state (following rust-cache best practices)
pre_job_cleanup() {
  echo "[entrypoint] Performing pre-job cleanup..."
  
  # Determine the actual HOME directory (GitHub Actions may override this)
  ACTUAL_HOME="${HOME:-/home/runner}"
  echo "[entrypoint] Working with HOME directory: $ACTUAL_HOME"
  
  # Clean up Cargo registry cache following rust-cache patterns
  # Focus on removing cache and src directories that cargo can regenerate
  for cargo_home in "/root/.cargo" "/home/runner/.cargo" "$ACTUAL_HOME/.cargo" "/github/home/.cargo"; do
    if [ -d "$cargo_home/registry/cache" ]; then
      echo "[entrypoint] Cleaning Cargo registry cache in $cargo_home"
      find "$cargo_home/registry/cache" -name "*.crate" -mtime +7 -delete 2>/dev/null || true
    fi
    if [ -d "$cargo_home/registry/src" ]; then
      echo "[entrypoint] Cleaning Cargo registry src in $cargo_home"
      rm -rf "$cargo_home/registry/src"/* 2>/dev/null || true
    fi
  done
  
  # Clean up target directories (where most space is used)
  echo "[entrypoint] Cleaning target directories..."
  find . -name "target" -type d -path "*/target" 2>/dev/null | while read -r target_dir; do
    if [ -d "$target_dir" ]; then
      echo "[entrypoint] Cleaning $target_dir"
      # Remove debug and release artifacts older than 1 week
      find "$target_dir" -type f -mtime +7 -delete 2>/dev/null || true
      # Clean incremental compilation artifacts
      rm -rf "$target_dir"/*/incremental 2>/dev/null || true
    fi
  done
  
  # Clean up temporary build directories
  echo "[entrypoint] Cleaning temporary build directories..."
  rm -rf /tmp/cargo-* 2>/dev/null || true
  rm -rf /tmp/rust-* 2>/dev/null || true
  find /tmp -maxdepth 1 -name "*.tmp" -type f -delete 2>/dev/null || true
  
  # Show disk usage after cleanup
  echo "[entrypoint] Disk usage after cleanup:"
  df -h / 2>/dev/null || true
  echo "[entrypoint] Available space in /tmp:"
  df -h /tmp 2>/dev/null || true
}

# Deregister runner on shutdown
cleanup() {
  echo "[entrypoint] Caught signal, performing cleanup..."
  
  # More aggressive cleanup following rust-cache best practices
  echo "[entrypoint] Cleaning Rust/Cargo artifacts..."
  
  # Clean target directories (main space consumers)
  find . -name "target" -type d -path "*/target" 2>/dev/null | while read -r target_dir; do
    if [ -d "$target_dir" ]; then
      echo "[entrypoint] Cleaning target directory: $target_dir"
      rm -rf "$target_dir"/* 2>/dev/null || true
    fi
  done
  
  # Clean Cargo caches in all possible locations
  for cargo_home in "/root/.cargo" "/home/runner/.cargo" "${HOME:-/home/runner}/.cargo" "/github/home/.cargo"; do
    if [ -d "$cargo_home" ]; then
      echo "[entrypoint] Cleaning Cargo cache in $cargo_home"
      rm -rf "$cargo_home/registry/cache"/* 2>/dev/null || true
      rm -rf "$cargo_home/registry/src"/* 2>/dev/null || true
      rm -rf "$cargo_home/git/checkouts"/* 2>/dev/null || true
    fi
  done
  
  # Clean temporary files
  rm -rf /tmp/cargo-* /tmp/rust-* 2>/dev/null || true
  find /tmp -type f -name "*" -mtime +0 -delete 2>/dev/null || true
  
  # Clean up Docker resources if available
  echo "[entrypoint] Cleaning Docker resources..."
  docker system prune -f 2>/dev/null || true
  
  # Remove runner from GitHub
  echo "[entrypoint] Removing runner from GitHub..."
  local removal_token
  removal_token=$(get_removal_token)
  ./config.sh remove --token "$removal_token" || true
  
  echo "[entrypoint] Cleanup completed"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Perform pre-job cleanup
pre_job_cleanup

# Get registration token
REG_TOKEN=$(get_registration_token)

# Configure runner
./config.sh \
  --url "$REPO_URL" \
  --token "$REG_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --unattended \
  --replace

# Start runner (foreground)
./run.sh &
wait $!

#!/bin/bash
# Invoked inside an explicitly authorized disposable Debian 12 image-build VM.
set -euo pipefail
umask 077
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
test -f /tmp/worker-build/docker/runner-release.json
test ! -e /var/lib/ephemeral-runner
case "${APT_SNAPSHOT:?fixed Debian snapshot timestamp required}" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) exit 1 ;;
esac
# No floating apt repository inputs. Authenticate Release metadata with the
# Debian archive keyring supplied by the explicitly pinned GCE base image.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources
cat > /etc/apt/sources.list <<EOF
deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian/${APT_SNAPSHOT}/ bookworm main
deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian-security/${APT_SNAPSHOT}/ bookworm-security main
EOF
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl python3 git libicu72 libssl3 zlib1g libkrb5-3 liblttng-ust1
getent passwd runner >/dev/null && exit 1
useradd --system --user-group --home-dir /var/lib/ephemeral-runner --shell /usr/sbin/nologin runner
install -d -m 0700 -o runner -g runner /var/lib/ephemeral-runner
install -d -m 0755 /opt/runner-bootstrap
runner_url=$(python3 -c 'import json; print(json.load(open("/tmp/worker-build/docker/runner-release.json"))["url"])')
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 600 --output /tmp/runner.tar.gz "$runner_url"
python3 /tmp/worker-build/docker/install-runner.py /tmp/worker-build/docker/runner-release.json /tmp/runner.tar.gz /var/lib/ephemeral-runner/runner
chown -R runner:runner /var/lib/ephemeral-runner
chmod -R go-w /var/lib/ephemeral-runner/runner
install -m 0644 /tmp/worker-build/startup/*.py /opt/runner-bootstrap/
install -m 0644 /tmp/worker-build/startup/one-job-worker.service /etc/systemd/system/
systemctl daemon-reload
# Do not start: build VM has no allocation, job, broker or worker identity.
systemctl enable one-job-worker.service
install -d -m 0755 /usr/share/one-job-worker
cp /tmp/worker-build/docker/runner-release.json /usr/share/one-job-worker/
dpkg-query -W -f='${Package}\t${Version}\n' > /usr/share/one-job-worker/packages.tsv
printf '%s\n' "$APT_SNAPSHOT" > /usr/share/one-job-worker/apt-snapshot.txt
test -z "$(find /var/lib/ephemeral-runner -maxdepth 1 -type f -print -quit)"
rm -rf /tmp/runner.tar.gz /tmp/worker-build
apt-get clean

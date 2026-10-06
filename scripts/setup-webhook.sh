#!/usr/bin/env bash
# Register the deployed managed endpoint; neither credentials nor responses are printed.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for cli in terraform gh python3; do command -v "$cli" >/dev/null || { echo "Missing prerequisite: $cli" >&2; exit 1; }; done
url=$(terraform -chdir="$root/terraform" output -raw webhook_url)
python3 -c 'import sys,urllib.parse; u=urllib.parse.urlsplit(sys.argv[1]); sys.exit(0 if u.scheme=="https" and u.hostname and not u.username and not u.password else 1)' "$url" || { echo 'A deployed HTTPS webhook_url output is required.' >&2; exit 1; }
read -r -p 'GitHub repository owner: ' owner
read -r -p 'GitHub repository name: ' repo
[[ "$owner" =~ ^[A-Za-z0-9-]+$ && "$repo" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid repository coordinates.' >&2; exit 1; }
read -r -s -p 'Webhook secret matching the deployed secret version: ' secret
printf '\n'
[[ -n "$secret" && "$secret" =~ [^[:space:]] ]] || { echo 'Webhook secret is required.' >&2; exit 1; }
# A pipe avoids storing the secret in a request file; responses can contain credentials.
printf '%s\0%s' "$url" "$secret" | python3 -c 'import json,sys; url,value=sys.stdin.read().split("\0",1); print(json.dumps({"name":"web","active":True,"events":["workflow_job"],"config":{"url":url,"content_type":"json","secret":value,"insecure_ssl":"0"}}))' | gh api --method POST "repos/$owner/$repo/hooks" --input - >/dev/null
unset secret url
echo 'GitHub workflow_job webhook registered.'

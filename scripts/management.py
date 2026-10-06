#!/usr/bin/env python3
"""Invoke one authenticated, fenced controller operation; default is local validation."""
import argparse
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

OPERATIONS = ('requestDrain', 'prepareStop', 'dispatchDrain', 'dispatchStop', 'retire', 'reconcileOrphan', 'recover', 'scheduled')
FIELDS = ('key', 'token', 'name', 'zone', 'project', 'instanceId', 'instanceCreationTimestamp', 'claimId')
UUID = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'


def validated_body(operation, path):
    body = json.loads(path.read_text())
    if operation == 'scheduled':
        if body != {}:
            raise ValueError('Scheduled operation requires an empty JSON object.')
    else:
        if not isinstance(body, dict) or set(body) != {'request'} or not isinstance(body['request'], dict) or set(body['request']) != set(FIELDS):
            raise ValueError('A complete fenced request object is required.')
        request = body['request']
        patterns = dict(key=r'[a-f0-9]{64}', token=UUID, claimId=UUID, name=r'[a-z][a-z0-9-]{0,61}[a-z0-9]',
                        zone=r'[a-z]+(?:-[a-z]+)+[0-9]-[a-z]', project=r'[a-z][a-z0-9-]{4,28}[a-z0-9]',
                        instanceId=r'[1-9][0-9]{0,19}', instanceCreationTimestamp=r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})')
        if any(not isinstance(request[key], str) or not re.fullmatch(pattern, request[key]) for key, pattern in patterns.items()):
            raise ValueError('Invalid fenced request fields.')
        body = {'request': {field: request[field] for field in FIELDS}}
    return json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode()


def endpoint(base_url, operation):
    url = urllib.parse.urlsplit(base_url)
    # Cloud Functions' canonical URL includes the function name as a path base;
    # retain it when appending an internal management route.
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or \
            not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*/?', url.path):
        raise ValueError('A canonical HTTPS controller base URL is required.')
    return base_url.rstrip('/') + '/management/' + operation


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=OPERATIONS)
    parser.add_argument('--request', type=Path, required=True, help='Ignored local JSON file containing exact allocation identity/fences.')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--controller-url')
    parser.add_argument('--identity-token-file', type=Path, help='Existing short-lived token for the configured administrator and controller audience.')
    args = parser.parse_args()
    payload = validated_body(args.operation, args.request)
    if not args.execute:
        print('Management request validated locally. No authentication or API call performed.')
        return
    target = endpoint(args.controller_url or '', args.operation)
    if args.identity_token_file is None:
        raise ValueError('An existing administrator identity-token file is required.')
    token = args.identity_token_file.read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
        raise ValueError('Invalid identity-token format.')
    request = urllib.request.Request(target, data=payload,
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.build_opener(NoRedirects()).open(request, timeout=30) as response:
        answer = json.loads(response.read(4096))
    if answer.get('ok') is not True or answer.get('code') != 'MANAGEMENT_HANDLED':
        raise ValueError('Controller did not confirm the operation.')
    print('Controller confirmed the management operation. Check durable controller records for details.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, urllib.error.URLError, json.JSONDecodeError):
        print('Management request failed validation or the authenticated controller call failed. No credentials or response details are printed.', file=sys.stderr)
        sys.exit(1)

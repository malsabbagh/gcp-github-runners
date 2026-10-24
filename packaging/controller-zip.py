#!/usr/bin/env python3
"""Create and inspect the exact reviewed controller source ZIP; no deployment."""
import hashlib, json, pathlib, re, stat, sys, zipfile

def main():
    directory=pathlib.Path(sys.argv[1]);archive=pathlib.Path(sys.argv[2]);manifest=json.loads(pathlib.Path(sys.argv[3]).read_text())
    if archive.exists() or archive.is_symlink():raise ValueError('ARCHIVE_DESTINATION_INVALID')
    expected={row['path']:row['sha256'] for row in manifest['files']}
    expected_modes=json.loads(pathlib.Path(sys.argv[4]).read_text())['modes']
    if set(expected_modes)!=set(expected) or any(mode not in ('0644','0755') for mode in expected_modes.values()):raise ValueError('ARCHIVE_MODE_CONTRACT_INVALID')
    if len(expected)!=len(manifest['files']) or any(not re.fullmatch(r'[A-Za-z0-9._/-]{1,240}',p) or any(x in ('','.','..') for x in p.split('/')) for p in expected):raise ValueError('ARCHIVE_MANIFEST_INVALID')
    leaves=list(directory.rglob('*'))
    if any(p.is_symlink() for p in leaves) or {p.relative_to(directory).as_posix() for p in leaves if p.is_file()}!=set(expected):raise ValueError('ARCHIVE_INVENTORY_INVALID')
    modes={};payloads={}
    for name,digest in expected.items():
        path=directory/name;mode=path.stat().st_mode
        if not stat.S_ISREG(mode):raise ValueError('ARCHIVE_FILE_INVALID')
        if stat.S_IMODE(mode)!=int(expected_modes[name],8):raise ValueError('ARCHIVE_MODE_MISMATCH')
        payload=path.read_bytes()
        if hashlib.sha256(payload).hexdigest()!=digest:raise ValueError('ARCHIVE_HASH_MISMATCH')
        modes[name]=mode;payloads[name]=payload
    with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED) as out:
        for name in sorted(expected):
            info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0));info.create_system=3;info.external_attr=modes[name]<<16;info.compress_type=zipfile.ZIP_DEFLATED
            out.writestr(info,payloads[name])
    with zipfile.ZipFile(archive) as check:
        rows=check.infolist()
        if len(rows)!=len(expected) or {row.filename for row in rows}!=set(expected):raise ValueError('ARCHIVE_INVENTORY_INVALID')
        for row in rows:
            if not stat.S_ISREG(row.external_attr>>16) or stat.S_IMODE(row.external_attr>>16)!=stat.S_IMODE(modes[row.filename]) or hashlib.sha256(check.read(row)).hexdigest()!=expected[row.filename]:raise ValueError('ARCHIVE_CONTENT_INVALID')
    print(json.dumps({'ok':True,'fileCount':len(expected),'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
if __name__=='__main__':main()

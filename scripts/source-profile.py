"""Materialize the executable source profile with explicit local configuration.

No installation, provider call, workflow dispatch or command execution occurs.
Run a restored command deliberately from the generated working directory.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

PROFILE = Path(__file__).resolve().parents[1] / "source-compatible"
SAFE_VALUE = re.compile(r"[A-Za-z0-9._:/@+=,-]+\Z")


def materialize(configuration, output, profile=PROFILE):
    manifest = json.loads((profile / "manifest.json").read_text())
    if not isinstance(configuration, dict) or set(configuration) != set(manifest["inputs"]):
        raise ValueError("Supply exactly the configuration inputs listed in the manifest.")
    if any(not isinstance(value, str) or not SAFE_VALUE.fullmatch(value)
           for value in configuration.values()):
        raise ValueError("Configuration values must be literal identifiers, URLs or encoded values.")
    output = Path(output)
    if output.exists():
        raise ValueError("Use a new output directory; existing operator inputs are never overwritten.")
    files = []
    for entry in manifest["files"]:
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid source path.")
        template_relative = Path(entry.get("template_path", entry["path"]))
        if template_relative.is_absolute() or ".." in template_relative.parts:
            raise ValueError("Invalid template path.")
        template = profile / "templates" / template_relative
        if template.is_symlink():
            raise ValueError("Source templates cannot be symlinks.")
        data = template.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["template_sha256"]:
            raise ValueError("A source template differs from the reviewed manifest.")
        text = data.decode("utf-8")
        for name, value in configuration.items():
            text = text.replace(name, value)
        if re.search(r"PARITY_INPUT_[0-9]{3}", text):
            raise ValueError("Unresolved configuration input.")
        files.append((relative, text.encode("utf-8"), entry["mode"]))
    output.mkdir(parents=True, mode=0o700)
    for relative, data, mode in files:
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination.write_bytes(data)
        destination.chmod(0o700 if mode == "100755" else 0o600)
    return len(files)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--configuration", type=Path, required=True,
                        help="Ignored local JSON with the inputs in source-compatible/manifest.json.")
    parser.add_argument("--output-name", required=True,
                        help="New directory name beneath ignored .source-profile/.")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.output_name) or args.output_name in (".", ".."):
        parser.error("Invalid output name.")
    config = json.loads(args.configuration.read_text())
    root = PROFILE.parent / ".source-profile" / args.output_name
    count = materialize(config, root)
    print(f"Materialized {count} executable/configuration files in {root}. Nothing was executed.")

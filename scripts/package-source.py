#!/usr/bin/env python3
"""Reproducible source-only ZIP; never packages user home, secrets or build caches."""
import argparse
import pathlib
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('output', type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
excluded = {'.git', 'target', 'node_modules', 'dist', '.DS_Store', '.env', 'test-results', 'playwright-report', 'gen'}
output = args.output.resolve()
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if any(part in excluded for part in relative.parts) or not path.is_file() or path.resolve() == output or path.is_symlink() or path.name.endswith('.tsbuildinfo'):
            continue
        info = zipfile.ZipInfo('ai-config-manager/' + relative.as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o755 if path.suffix == '.sh' else 0o644) << 16
        archive.writestr(info, path.read_bytes())
print(output)

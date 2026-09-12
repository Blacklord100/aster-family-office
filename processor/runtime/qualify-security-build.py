"""Build and exercise the actual patched native libraries; bind evidence to bytes."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    root = Path('/build')
    sources = json.loads((root / 'upstream-sources.json').read_text())
    source = root / 'sources' / sources['tesseract']['directory']
    includes = [source, source / 'include', source / 'include/tesseract', root / 'tesseract-build',
                root / 'tesseract-build/include',
                *sorted(path for path in (source / 'src').iterdir() if path.is_dir())]
    binary = root / 'security-regression'
    # Internal Classify headers include Leptonica's allheaders.h. Use the same
    # installed development package metadata as Tesseract's own build.
    lept_flags = shlex.split(subprocess.run(['pkg-config', '--cflags', 'lept'], check=True,
                                           capture_output=True, text=True, timeout=10).stdout)
    # Match internal header ABI to Tesseract's generated build configuration,
    # including FAST_FLOAT (enabled by default), legacy engine and graphics flags.
    # Upstream selects C++20 when the Debian builder supports it; internal
    # constexpr coordinate helpers rely on that standard's initialization rules.
    subprocess.run(['g++', '-std=c++20', '-O1', '-fstack-protector-strong', '-DHAVE_CONFIG_H',
                    *(f'-I{path}' for path in includes), *lept_flags, '-I/opt/libtiff/include',
                    str(root / 'security-regression.cc'), '-o', str(binary),
                    '-L/opt/tesseract/lib', '-L/opt/libtiff/lib', '-ltesseract', '-ltiff', '-llept', '-pthread'],
                   check=True, timeout=120)
    run = subprocess.run([str(binary)], capture_output=True, text=True, check=True, timeout=30,
                         env={**os.environ, 'OMP_NUM_THREADS': '1'})
    checks = json.loads(run.stdout.strip().splitlines()[-1])
    if checks != {'schemaVersion': 1, 'networkCases': 12, 'normprotoCases': 3,
                  'tiffCodecCases': 3, 'passed': True}:
        raise RuntimeError('Unexpected security regression coverage')
    # Retain exact source identities for original release fixes as well as backports.
    relevant = {'tesseract': ['src/lstm/convolve.cpp', 'src/lstm/reconfig.cpp',
                              'src/classify/normmatch.cpp', 'src/lstm/fullyconnected.cpp',
                              'src/lstm/weightmatrix.h', 'src/lstm/lstm.cpp', 'src/lstm/networkio.cpp'],
                'libtiff': ['libtiff/tif_read.c', 'libtiff/tif_compress.c', 'tools/tiffcrop.c']}
    source_files = {name: {path: sha(root / 'sources' / sources[name]['directory'] / path)
                           for path in paths} for name, paths in relevant.items()}
    native_files = ['/opt/tesseract/bin/tesseract', '/opt/tesseract/lib/libtesseract.so.5',
                    '/opt/libtiff/lib/libtiff.so.6']
    receipt = {'schemaVersion': 1, 'checks': checks, 'sourceFiles': source_files,
               'nativeFiles': {path: sha(Path(path)) for path in native_files},
               'harnessSha256': sha(root / 'security-regression.cc'),
               'sourceConfigurationSha256': sha(root / 'upstream-sources.json'),
               'backports': json.loads((root / 'security-backports.json').read_text())}
    (root / 'security-build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'nativeSecurityRegression': checks}))


if __name__ == '__main__':
    main()

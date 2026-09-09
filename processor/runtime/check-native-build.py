"""Fail the builder if either image decoder resolves an older TIFF payload."""
import ctypes
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

from PIL import Image, features
import PIL

DISABLED = ['freetype', 'raqm', 'lcms', 'webp', 'jpeg2000', 'imagequant', 'xcb', 'avif']
FEATURE_NAMES = {'freetype': 'freetype2', 'lcms': 'littlecms2', 'jpeg2000': 'jpg_2000',
                 'imagequant': 'libimagequant'}


def main():
    tiff_path = '/opt/libtiff/lib/libtiff.so.6'
    library = ctypes.CDLL(tiff_path)
    library.TIFFGetVersion.restype = ctypes.c_char_p
    if not library.TIFFGetVersion().decode().startswith('LIBTIFF, Version 4.7.2\n'):
        raise RuntimeError('System TIFF does not use the authenticated 4.7.2 release')
    library.TIFFIsCODECConfigured.argtypes = [ctypes.c_uint16]
    library.TIFFIsCODECConfigured.restype = ctypes.c_int
    codecs = {'ccitt': 2, 'lzw': 5, 'old-jpeg': 6, 'jpeg': 7, 'deflate': 8,
              'packbits': 32773, 'jbig': 34661, 'lzma': 34925,
              'zstd': 50000, 'webp': 50001, 'lerc': 34887}
    if not all(library.TIFFIsCODECConfigured(value) for value in codecs.values()):
        raise RuntimeError('An existing TIFF compression codec was lost in the rebuild')
    header = Path('/opt/libtiff/include/tiffconf.h').read_text()
    if not re.search(r'^#define LIBDEFLATE_SUPPORT 1$', header, re.MULTILINE):
        raise RuntimeError('TIFF libdeflate support was not compiled')
    if PIL.__version__ != '12.3.0' or features.version_codec('libtiff') != '4.7.2':
        raise RuntimeError('Pillow must retain its locked version and use fixed TIFF')
    if not all(features.check_codec(name) for name in ['zlib', 'jpg', 'libtiff']):
        raise RuntimeError('A required Pillow decoder is unavailable')
    for name in DISABLED:
        if features.check(FEATURE_NAMES.get(name, name)):
            raise RuntimeError(f'Unexpected optional Pillow build feature: {name}')
    for format_name in ['PNG', 'JPEG', 'TIFF']:
        stream = io.BytesIO()
        options = {'compression': 'tiff_lzw'} if format_name == 'TIFF' else {}
        Image.new('RGB', (12, 9), (10, 80, 150)).save(stream, format=format_name, **options)
        stream.seek(0)
        with Image.open(stream) as decoded:
            decoded.load()
            if decoded.size != (12, 9) or decoded.format != format_name:
                raise RuntimeError(f'Failed {format_name} image round trip')
    pillow_dir = Path(PIL.__file__).parent
    if list(pillow_dir.parent.glob('pillow.libs/*tiff*')):
        raise RuntimeError('A separately bundled TIFF library remains in Pillow')
    for path in [Path('/opt/tesseract/bin/tesseract'), *pillow_dir.glob('*.so')]:
        linked = subprocess.check_output(['ldd', str(path)], text=True)
        tiff_lines = [line for line in linked.splitlines() if 'libtiff.so' in line]
        if not tiff_lines or any('=> /opt/libtiff/lib/libtiff.so.6 ' not in line for line in tiff_lines):
            # Pure morphology C extensions do not all link TIFF. The core image
            # extension and the OCR binary do, including Leptonica transitively.
            if tiff_lines or path.name == 'tesseract' or path.name.startswith('_imaging.'):
                raise RuntimeError(f'Native dependency selected an unexpected TIFF: {path.name}')
    wheels = list(Path('/build/pillow-wheel').glob('pillow-12.3.0-*.whl'))
    if len(wheels) != 1:
        raise RuntimeError('Expected exactly one locally built Pillow wheel')
    receipt = {'pillow': {'version': PIL.__version__, 'libtiffVersion': features.version_codec('libtiff'),
                          'buildWheel': {'filename': wheels[0].name,
                                         'sha256': hashlib.sha256(wheels[0].read_bytes()).hexdigest()},
                          'enabledCodecs': ['zlib', 'jpeg', 'tiff'], 'disabledFeatures': DISABLED},
               'libtiff': {'libraryPath': tiff_path, 'codecs': codecs}}
    Path('/build/native-build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()

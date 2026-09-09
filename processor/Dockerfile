# syntax=docker/dockerfile:1
# Keep the interpreter and native wheels on CPython 3.12 / Debian 13 throughout.
ARG PYTHON_IMAGE=python:3.12.13-slim-trixie@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36
ARG PROCESSOR_RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:c31ff9abcb1910f3ab25c7957bdaf0bfe12a01eb546e8df2282f1c8f682b606c
FROM ${PROCESSOR_RUNTIME_IMAGE} AS runtime-base

FROM ${PYTHON_IMAGE} AS builder
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
# Build tools never enter the runtime. Debian dependencies retain APT metadata;
# upstream OCR sources are authenticated and pinned separately below.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends cmake g++ make pkg-config gpgv \
      libleptonica-dev tesseract-ocr-eng zlib1g-dev libdeflate-dev libjpeg62-turbo-dev \
      liblzma-dev libzstd-dev libwebp-dev liblerc-dev libjbig-dev
COPY runtime/upstream-sources.json runtime/fetch-sources.py runtime/check-native-build.py /build/
COPY runtime/source-provenance/ /build/source-provenance/
RUN python /build/fetch-sources.py
# Preserve libtiff's shared C ABI and compression codecs used by Leptonica;
# only ancillary command-line tools, docs and C++ wrappers are excluded.
RUN cmake -S /build/sources/tiff-4.7.2 -B /build/tiff-build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/libtiff -DCMAKE_INSTALL_LIBDIR=lib \
      -DBUILD_SHARED_LIBS=ON -Dtiff-static=OFF -Dtiff-tools=OFF -Dtiff-tests=OFF \
      -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dtiff-cxx=OFF -Dld-version-script=ON \
      -Dzlib=ON -Dlibdeflate=ON -Djpeg=ON -Dold-jpeg=ON -Dlzma=ON \
      -Dzstd=ON -Dwebp=ON -Dlerc=ON -Djbig=ON \
    && cmake --build /build/tiff-build --parallel 2 \
    && cmake --install /build/tiff-build
ENV LD_LIBRARY_PATH=/opt/libtiff/lib:/opt/tesseract/lib:/usr/local/lib \
    PKG_CONFIG_PATH=/opt/libtiff/lib/pkgconfig
# OCR only consumes our locally rendered PNG. Network/archive inputs, graphical
# debugging and training tools are unnecessary; their libraries are not shipped.
RUN cmake -S /build/sources/tesseract-5.5.3 -B /build/tesseract-build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/tesseract \
      -DCMAKE_PREFIX_PATH=/opt/libtiff -DCMAKE_INSTALL_LIBDIR=lib \
      '-DCMAKE_INSTALL_RPATH=/opt/tesseract/lib;/opt/libtiff/lib' -DTESSDATA_PREFIX=/opt/tesseract/share \
      -DBUILD_SHARED_LIBS=ON -DBUILD_TRAINING_TOOLS=OFF -DBUILD_TESTS=OFF \
      -DDISABLE_ARCHIVE=ON -DDISABLE_CURL=ON -DGRAPHICS_DISABLED=ON \
      -DENABLE_NATIVE=OFF -DENABLE_LTO=OFF -DOPENMP_BUILD=ON \
    && cmake --build /build/tesseract-build --parallel 2 \
    && cmake --install /build/tesseract-build
# Rebuild the same locked Pillow release so its prebuilt wheel cannot retain a
# second, older bundled libtiff. The isolated, pinned build tools stay in /build.
RUN python -m venv /build/pillow-venv \
    && /build/pillow-venv/bin/python -m pip install --no-index --no-deps \
      /build/sources/setuptools-84.0.0-py3-none-any.whl /build/sources/pybind11-3.1.0-py3-none-any.whl \
    && TIFF_ROOT=/opt/libtiff LDFLAGS='-L/opt/libtiff/lib -Wl,-rpath,/opt/libtiff/lib' \
      /build/pillow-venv/bin/python -m pip wheel --no-index --no-deps --no-build-isolation --no-cache-dir \
      --wheel-dir /build/pillow-wheel /build/sources/pillow-12.3.0 \
      -C zlib=enable -C jpeg=enable -C tiff=enable -C parallel=2 \
      -C freetype=disable -C raqm=disable -C lcms=disable -C webp=disable \
      -C jpeg2000=disable -C imagequant=disable -C xcb=disable -C avif=disable \
    && python -m pip install --no-index --no-deps /build/pillow-wheel/*.whl \
    && python /build/check-native-build.py
WORKDIR /srv/processor
COPY requirements.lock.txt ./
RUN python -m pip install --no-cache-dir --only-binary=:all: -r requirements.lock.txt
COPY --from=runtime-base / /runtime-base/
COPY runtime/assemble.py /build/assemble.py
RUN python /build/assemble.py

# /runtime already contains the full pinned Distroless base. An exact root copy
# prevents deleted/replaced base-package files surviving from a lower image layer.
FROM scratch AS runner
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
    PATH="/usr/local/bin:/opt/tesseract/bin:/usr/bin:/bin" LANG=C.UTF-8
# Contains the base plus a checked native dependency closure and complete package
# metadata. Keeping the base files permits an exact version-consistent merge.
COPY --from=builder /runtime/ /
WORKDIR /srv/processor
COPY requirements.lock.txt ./
COPY service ./service
COPY corpus ./corpus
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--limit-concurrency", "8", "--timeout-keep-alive", "5"]

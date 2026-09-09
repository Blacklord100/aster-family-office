# syntax=docker/dockerfile:1
# Keep the interpreter and native wheels on CPython 3.12 / Debian 13 throughout.
ARG PYTHON_IMAGE=python:3.12.13-slim-trixie@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36
ARG PROCESSOR_RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:c31ff9abcb1910f3ab25c7957bdaf0bfe12a01eb546e8df2282f1c8f682b606c
FROM ${PROCESSOR_RUNTIME_IMAGE} AS runtime-base

FROM ${PYTHON_IMAGE} AS builder
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
# Build tools never enter the runtime. apt authenticates the Debian source index;
# the source descriptor and three archives are additionally SHA256-pinned.
RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends cmake g++ make pkg-config dpkg-dev libleptonica-dev tesseract-ocr-eng \
    && mkdir -p /build/tesseract
WORKDIR /build/tesseract
RUN apt-get source --download-only tesseract=5.5.0-1
COPY runtime/tesseract-source.sha256 ./
RUN sha256sum --check tesseract-source.sha256 \
    && dpkg-source -x tesseract_5.5.0-1.dsc source
# OCR only consumes our locally rendered PNG. Network/archive inputs, graphical
# debugging and training tools are unnecessary; their libraries are not shipped.
RUN cmake -S source -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/tesseract \
      -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_RPATH=/opt/tesseract/lib -DTESSDATA_PREFIX=/opt/tesseract/share \
      -DBUILD_SHARED_LIBS=ON -DBUILD_TRAINING_TOOLS=OFF -DBUILD_TESTS=OFF \
      -DDISABLE_ARCHIVE=ON -DDISABLE_CURL=ON -DGRAPHICS_DISABLED=ON \
      -DENABLE_NATIVE=OFF -DENABLE_LTO=OFF -DOPENMP_BUILD=ON \
    && cmake --build build --parallel 2 \
    && cmake --install build
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

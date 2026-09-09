FROM python:3.14.7-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 processor && useradd --uid 10001 --gid 10001 --no-create-home processor
WORKDIR /srv/processor
COPY requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY service ./service
COPY corpus ./corpus
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--limit-concurrency", "8", "--timeout-keep-alive", "5"]

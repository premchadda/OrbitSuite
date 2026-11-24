FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/orbitsuite/services/media_worker
COPY services/media_worker/requirements.txt /srv/orbitsuite/services/media_worker/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/media_worker/worker.py /srv/orbitsuite/services/media_worker/worker.py
COPY services/media_worker/media_features.py /srv/orbitsuite/services/media_worker/media_features.py
COPY services/media_worker/telegram_parts.py /srv/orbitsuite/services/media_worker/telegram_parts.py
COPY services/media_worker/telegram_transcribe.py /srv/orbitsuite/services/media_worker/telegram_transcribe.py
COPY services/ai/transcribe.py /srv/orbitsuite/services/ai/transcribe.py
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1
CMD ["python", "worker.py"]

FROM python:3.12-slim
WORKDIR /srv/orbitsuite
COPY services/automation/rss.py /srv/orbitsuite/services/automation/rss.py
COPY services/ai/lookup.py /srv/orbitsuite/services/ai/lookup.py
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1
CMD ["python", "-m", "services.automation.rss", "--serve", "--host", "127.0.0.1", "--port", "8188"]

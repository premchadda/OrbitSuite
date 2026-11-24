FROM node:24-alpine
WORKDIR /srv/orbitsuite
COPY apps/dashboard/ apps/dashboard/
COPY apps/worker/src/ apps/worker/src/
COPY apps/worker/migrations/ apps/worker/migrations/
COPY apps/local/src/ apps/local/src/
COPY apps/local/package.json apps/local/package.json
RUN mkdir -p /data && chown node:node /data
USER node
ENV ORBIT_DB_PATH=/data/orbitsuite.sqlite \
    ORBIT_HOST=0.0.0.0 ORBIT_PORT=8787 ORBIT_MODE=polling
CMD ["node", "apps/local/src/runtime.js"]

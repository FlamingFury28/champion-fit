FROM node:24-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,id=champion-fit-npm,target=/root/.npm,sharing=locked npm ci
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/public/ ./public/
COPY frontend/src/ ./src/
RUN npm run build


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN --mount=type=cache,id=champion-fit-pip,target=/root/.cache/pip,sharing=locked python -m pip install -r requirements.txt

COPY *.py ./
COPY schema.sql ./
COPY champion_archetypes.json ./
COPY --from=frontend-build /build/frontend/dist ./frontend/dist

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/sync-status', timeout=2).read()"]

CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "8787"]

FROM python:3.12-alpine

RUN apk add --no-cache netcat-openbsd

WORKDIR /app

COPY exporter.py /app/exporter.py

CMD ["python", "/app/exporter.py"]

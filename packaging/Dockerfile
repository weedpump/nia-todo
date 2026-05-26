FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NIA_TODO_HOST=0.0.0.0 \
    NIA_TODO_PORT=8753 \
    NIA_TODO_DB=nia-todo.db

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /app/api/data \
    && useradd -m -u 10001 nia-todo \
    && chown -R nia-todo:nia-todo /app

USER nia-todo
EXPOSE 8753
VOLUME ["/app/api/data"]

CMD ["./start.sh"]

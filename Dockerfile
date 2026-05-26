FROM python:3.13.5-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NIA_TODO_HOST=0.0.0.0 \
    NIA_TODO_PORT=8753 \
    NIA_TODO_DATA_DIR=/data \
    NIA_TODO_DB=nia-todo.db

WORKDIR /app

COPY requirements.txt ./
COPY wheelhouse ./wheelhouse
RUN pip install --no-cache-dir --no-index --find-links=wheelhouse -r requirements.txt \
    && rm -rf wheelhouse

COPY . .
RUN mkdir -p /data \
    && useradd -m -u 10001 nia-todo \
    && chown -R nia-todo:nia-todo /app /data

USER nia-todo
EXPOSE 8753
VOLUME ["/data"]

CMD ["./start.sh"]

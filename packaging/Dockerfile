FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NIA_TODO_HOST=0.0.0.0 \
    NIA_TODO_PORT=8753 \
    NIA_TODO_DB=nia-todo.db

WORKDIR /app

COPY requirements.txt ./
COPY wheelhouse ./wheelhouse
RUN pip install --no-cache-dir --no-index --find-links=wheelhouse -r requirements.txt \
    && rm -rf wheelhouse

COPY . .
RUN mkdir -p /app/api/data \
    && useradd -m -u 10001 nia-todo \
    && chown -R nia-todo:nia-todo /app

USER nia-todo
EXPOSE 8753
VOLUME ["/app/api/data"]

CMD ["./start.sh"]

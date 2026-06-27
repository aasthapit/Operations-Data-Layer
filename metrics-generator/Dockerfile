FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir pyyaml==6.0.2
COPY generator.py .
EXPOSE 8000
CMD ["python", "generator.py"]

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8'); WhisperModel('small.en', device='cpu', compute_type='int8'); WhisperModel('tiny.en', device='cpu', compute_type='int8')"
RUN mkdir -p /voices && cd /voices && python -m piper.download_voices en_US-lessac-medium
ENV PIPER_VOICE=/voices/en_US-lessac-medium.onnx
COPY src ./src
EXPOSE 8080
CMD ["python", "src/main.py"]

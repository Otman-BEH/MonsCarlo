# Mons Carlo API (the backend). The web page in web/ is static and hosted separately.
# The NASA data (about 620 MB) is not in the image: on first start run.py downloads it into $MONS_CARLO_DATA (mount a
# persistent volume there), precomputes, pre-fetches the ephemeris, then serves. Later starts skip work already done.
FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MONS_CARLO_DATA=/data
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
EXPOSE 8000
CMD ["python", "backend/run.py", "--host", "0.0.0.0", "--port", "8000"]

FROM python:3.12-slim
ARG API_BASE=http://api:8000
ARG SEM_VALOR
ENV MOTOR_URL=http://motor:8089 OUTRA=1
EXPOSE 8081
CMD ["python", "-m", "src.web.app"]

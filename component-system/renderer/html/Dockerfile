# Use Python slim image
FROM python:3.11-slim

WORKDIR /app

# Copy HTML files
COPY . .

# Expose the port the server runs on
EXPOSE 8080

# Start the Python HTTP server
CMD ["python3", "-m", "http.server", "8080"]

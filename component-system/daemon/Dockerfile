# Use Node.js LTS
FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose the port the app runs on
EXPOSE 3001

ENV DAEMON_PORT=3001

# Start the daemon
CMD ["node", "simple-daemon.js"]

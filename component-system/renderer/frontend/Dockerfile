# Use Node.js LTS with Alpine for smaller image
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Set environment variable for development
ENV NODE_ENV=development

# Expose the port the app runs on
EXPOSE 3000

# Start the React development server
CMD ["npm", "start"]

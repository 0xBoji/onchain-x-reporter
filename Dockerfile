# Use Node.js LTS version as base image
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Copy all source files first
COPY . .

# Install dependencies and build
RUN npm install && \
    npm run build

# Create data directory
RUN mkdir -p data

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose the port for Google Cloud
EXPOSE 8080

# Start the application
CMD ["node", "dist/index.js"] 
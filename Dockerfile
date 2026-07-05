# Multi-stage build for optimized production image
FROM node:18-alpine AS builder

WORKDIR /app

# Install build dependencies and image processing libraries
# Note: dcraw has been removed from Alpine 3.21+, libraw provides RAW support
RUN apk add --no-cache \
    vips-dev \
    libraw-dev \
    imagemagick \
    libheif-dev \
    build-base \
    python3 \
    py3-pip \
    pkgconfig

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Rebuild Sharp with system libvips for optimal performance
RUN npm rebuild sharp --verbose

# Production stage
FROM node:18-alpine

WORKDIR /app

# Install only runtime dependencies for image processing
# libraw provides comprehensive RAW format support (ARW, CR2, NEF, DNG, etc.)
RUN apk add --no-cache \
    vips \
    libraw \
    imagemagick \
    libheif \
    tini \
    wget

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built application and dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]

# Start the application
CMD ["node", "dist/main"]

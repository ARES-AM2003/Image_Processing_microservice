FROM node:18-alpine

WORKDIR /app

# Install system dependencies for comprehensive image format support
# Core image processing libraries:
# - vips-dev: libvips development files for Sharp
# - libraw-dev: RAW image format support (ARW, CR2, NEF, DNG, etc.)
# - dcraw: Popular RAW converter utility as fallback
# - imagemagick: Additional image processing with RAW support
# - libheif-dev: HEIC/HEIF format support
# Build tools:
# - build-base: Compiler tools needed for native modules
# - python3: Required for node-gyp
# - pkgconfig: For finding libraries during compilation
RUN apk add --no-cache \
    vips-dev \
    libraw-dev \
    dcraw \
    imagemagick \
    libheif-dev \
    build-base \
    python3 \
    py3-pip \
    pkgconfig

# Copy package files
COPY package*.json ./

# Install dependencies and rebuild Sharp with system libvips
# This ensures Sharp uses the system libvips with libraw support
RUN npm ci --only=production && \
    npm rebuild sharp --verbose

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Clean up build dependencies to reduce image size
# Keep runtime libraries (vips, libraw, dcraw, imagemagick, libheif)
RUN apk del build-base python3 py3-pip pkgconfig

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "run", "start:prod"]
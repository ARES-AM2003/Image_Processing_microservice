# Image Processor Microservice

A standalone NestJS microservice for processing images, designed to work with the FotosfoLio backend.

## Features

- **Smart Processing Filters**: Only processes images ≥5MB, skips smaller files automatically
- **Queue-based Processing**: Uses BullMQ for managing image processing jobs
- **Sharp Image Processing**: High-performance image resizing and optimization
- **Wide Format Support**: Supports JPEG, PNG, WebP, HEIC, AVIF, and many RAW camera formats
- **Smart Format Handling**: PNG/WebP are compressed in original format, other formats converted to JPEG
- **Redis Integration**: Reliable job queue with Redis
- **REST API**: Same endpoints as the main FotosfoLio backend
- **Swagger Documentation**: Auto-generated API documentation
- **Scalable**: Can be deployed independently and scaled horizontally

## Processing Flow

### Automatic Filtering System
The microservice automatically filters images based on these criteria:

1. **✅ Extension Check**: Must be a supported image format
2. **✅ Content Validation**: Must be a valid image file (not corrupted)
3. **✅ Size Filter**: Must be ≥5MB (smaller images are automatically skipped)
4. **🔄 Format Processing**: 
   - **PNG & WebP**: Compressed in original format (no conversion)
   - **Other formats**: Converted to JPEG for optimal compatibility
5. **📸 Process**: Resize to max 1920px, format-specific compression

### Compression Settings by Format

#### PNG Files (Compression Only - No Conversion)
- **Quality**: 80
- **Compression Level**: 9 (maximum)
- **Adaptive Filtering**: Enabled
- **Output Format**: PNG (preserved)

#### WebP Files (Compression Only - No Conversion)
- **Quality**: 75
- **Effort**: 6 (higher effort for better compression)
- **Output Format**: WebP (preserved)

#### JPEG Files (Compression Only)
- **Quality**: 65
- **Progressive**: Disabled (faster encoding)
- **MozJPEG**: Enabled
- **Optimize Scans**: Enabled
- **Output Format**: JPEG (preserved)

#### Other Formats (Convert to JPEG)
All other formats (HEIC, HEIF, RAW, TIFF, BMP, etc.) are converted to JPEG with:
- **Quality**: 65
- **Progressive**: Disabled
- **MozJPEG**: Enabled
- **Output Format**: JPEG

### Files that get PROCESSED:
- Large images (≥5MB) in any supported format
- **PNG/WebP**: Compressed in original format (quality 80 PNG, 75 WebP)
- **HEIC photos**: Converted to JPEG
- **RAW camera files**: Converted to JPEG
- **TIFF/BMP/other formats**: Converted to JPEG

### Files that get SKIPPED:
- Small images (<5MB) - don't need compression
- Non-image files (PDFs, documents, etc.)
- Corrupted files

## API Endpoints

### POST /image-queue/enqueue
Enqueue images for processing (only large images will actually be processed).

**Request Body:**
```json
{
  "bucket": "my-s3-bucket-name",
  "keys": [
    "images/large-photo.jpg",      // ✅ Will compress as JPEG if ≥5MB
    "images/small-photo.png",      // ⏭️ Will skip if <5MB  
    "images/large-image.png",      // ✅ Will compress as PNG if ≥5MB (no conversion)
    "images/banner.webp",          // ✅ Will compress as WebP if ≥5MB (no conversion)
    "images/IMG_001.heic",         // ✅ Will convert to JPEG & compress if ≥5MB
    "camera/DSC_001.nef",          // ✅ Will convert RAW to JPEG if ≥5MB
    "documents/file.pdf"           // ⏭️ Will skip (not image)
  ]
}
```

**Response:**
```json
{
  "status": "enqueued",
  "count": 7,
  "message": "Images will be validated and processed according to size and format requirements"
}
```

**Processing Examples:**
- `photo.jpg` (8MB) → Compressed to `Preview/photo.jpg` (JPEG, ~2-3MB)

### DELETE /image-queue/clear
Stop and remove all current jobs from the queue (both waiting and active jobs).

**Response:**
```json
{
  "success": true,
  "clearTime": 150,
  "jobsRemoved": 1250,
  "before": {
    "waiting": 1200,
    "active": 5,
    "completed": 100,
    "failed": 10,
    "delayed": 0
  },
  "after": {
    "waiting": 0,
    "active": 0,
    "completed": 0,
    "failed": 0,
    "delayed": 0
  },
  "message": "Successfully cleared 1250 jobs from queue"
}
```

### GET /image-queue/status
Get the current status of the processing queue.

**Response:**
```json
{
  "worker": "running",
  "paused": false,
  "counts": {
    "waiting": 10,
    "active": 2,
    "completed": 100,
    "failed": 5,
    "delayed": 0
  }
}
```

### POST /image-queue/pause
Pause the queue processing. Jobs will not be processed until resumed.

**Response:**
```json
{
  "success": true,
  "message": "Queue paused"
}
```

### POST /image-queue/resume
Resume the paused queue processing.

**Response:**
```json
{
  "success": true,
  "message": "Queue resumed"
}
```
- `graphic.png` (12MB) → Compressed to `Preview/graphic.png` (PNG, ~4-5MB)
- `banner.webp` (6MB) → Compressed to `Preview/banner.webp` (WebP, ~2MB)
- `IMG_001.heic` (10MB) → Converted & compressed to `Preview/IMG_001.jpg` (JPEG)
- `DSC_001.nef` (25MB) → Converted & compressed to `Preview/DSC_001.jpg` (JPEG)

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy environment configuration:
   ```bash
   cp .env.template .env
   ```
4. Update `.env` with your S3 and Redis credentials
5. Start the service:
   ```bash
   npm run start:dev
   ```

The service will be available at `http://localhost:3001` with API docs at `/api`.

## Environment Variables Setup

### Required Variables (.env file)

```env
# Server Configuration
PORT=3001

# S3 Storage (REQUIRED)
S3_ACCESS_KEY=your_access_key_here
S3_SECRET_KEY=your_secret_key_here  
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.amazonaws.com

# Redis Queue (REQUIRED)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Optional Settings
BATCH_SIZE=20
BASE_CDN_URL=https://cdn.yoursite.com
```

### Quick Setup Examples

**Local Development with MinIO:**
```env
PORT=3001
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

**AWS Production:**
```env
PORT=3001
S3_ACCESS_KEY=AKIA...
S3_SECRET_KEY=wJal...
S3_REGION=us-west-2
S3_ENDPOINT=https://s3.us-west-2.amazonaws.com
REDIS_HOST=your-cluster.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=your_auth_token
```

Copy `.env.template` to `.env` and fill in your values.

## Scripts

- `npm run start` - Start the application
- `npm run start:dev` - Start in development mode with watch
- `npm run start:debug` - Start in debug mode
- `npm run build` - Build the application
- `npm run test` - Run tests

## API Documentation

Once the service is running, visit `http://localhost:3001/api` to view the Swagger documentation.

## Docker Support

Build and run with Docker:

```bash
docker build -t image-processor-microservice .
docker run -p 3001:3001 image-processor-microservice
```

## Supported Image Formats

### Standard Web Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- BMP (.bmp)
- TIFF (.tiff, .tif)
- WebP (.webp)
- SVG (.svg)
- ICO (.ico)

### Modern Formats
- HEIC (.heic) - Apple's High Efficiency Image Container
- HEIF (.heif) - High Efficiency Image Format
- AVIF (.avif) - AV1 Image File Format

### RAW Camera Formats
The service supports many RAW camera formats, including:
- Canon: .cr2, .cr3, .crw
- Nikon: .nef, .nrw
- Sony: .arw, .sr2, .srf
- Adobe: .dng
- Olympus: .orf
- Panasonic: .rw2, .rw1
- Pentax: .pef, .ptx
- Samsung: .srw
- Fujifilm: .raf
- Hasselblad: .3fr, .fff
- Phase One: .iiq, .cap
- Leica: .rwl
- And many more...

**Note**: RAW format support depends on the underlying libvips library compilation and available system libraries. Some RAW formats may require additional codecs or may not be fully supported in all environments.

### HEIC/HEIF Support
HEIC and HEIF formats are supported through Sharp's libvips integration. For optimal HEIC support, ensure your system has:
- libheif library installed
- For Docker deployments, the Sharp package will include necessary binaries
- macOS and modern Linux distributions typically have built-in support

### Performance Considerations
- RAW files are typically much larger and may require more processing time
- HEIC files are generally smaller than equivalent JPEG files but may take longer to decode
- Consider adjusting memory and timeout settings for heavy RAW processing workloads

## Architecture

This microservice is designed to be:
- **Independent**: No dependencies on the main FotosfoLio backend database
- **Scalable**: Can run multiple instances behind a load balancer
- **Reliable**: Uses Redis for persistent job queues
- **Compatible**: Same API endpoints as the main service

## Integration

To integrate with your existing FotosfoLio backend:

1. Update your main backend to point image processing requests to this microservice
2. Configure the same Redis instance for both services
3. Set up load balancing if running multiple instances
4. Monitor queues and processing status via the API endpoints
# Image_Processing_microservice
# Image_Processing_microservice

# Image Processor Microservice

A standalone NestJS microservice for processing images, designed to work with the FotosfoLio backend.

## Features

- **Queue-based Processing**: Uses BullMQ for managing image processing jobs
- **Sharp Image Processing**: High-performance image resizing and optimization
- **Redis Integration**: Reliable job queue with Redis
- **REST API**: Same endpoints as the main FotosfoLio backend
- **Swagger Documentation**: Auto-generated API documentation
- **Scalable**: Can be deployed independently and scaled horizontally

## API Endpoints

### POST /image-queue/enqueue
Enqueue images for processing.

**Request Body:**
```json
{
  "bucket": "my-s3-bucket-name",
  "keys": ["images/photo1.jpg", "images/photo2.png"]
}
```

**Response:**
```json
{
  "status": "enqueued",
  "count": 2
}
```

### GET /image-queue
Get current queue status.

**Response:**
```json
{
  "worker": "running",
  "paused": false,
  "counts": {
    "waiting": 5,
    "active": 1,
    "completed": 120,
    "failed": 2,
    "delayed": 0
  }
}
```

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy environment configuration:
   ```bash
   cp .env.example .env
   ```
4. Update `.env` with your configuration
5. Start the service:
   ```bash
   npm run start:dev
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password | `` |
| `BATCH_SIZE` | Batch size for processing | `20` |
| `BASE_CDN_URL` | CDN URL for processed images | `https://cdn.fotosfolio.com` |

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

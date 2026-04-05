# 🎙️ Scalable Voice Recording Pipeline

A production-ready, scalable voice recording system designed for 100-1000+ concurrent users. Features client-side chunking, OPFS persistence, S3 storage with presigned URLs, Redis caching, and comprehensive data integrity guarantees.

## ✨ Features

- **🔒 Zero Data Loss** — OPFS client-side buffer ensures recordings survive tab closes, network failures
- **⚡ Direct S3 Uploads** — Presigned URLs bypass server for large files, reducing latency
- **🚀 Redis Caching** — Metadata and presigned URLs cached for fast retrieval
- **📊 Rate Limiting** — Per-user/IP rate limiting with Redis backend
- **🔄 Auto-Reconciliation** — Detects and recovers missing chunks automatically
- **📈 Horizontally Scalable** — Stateless API servers, shared S3/Redis/PostgreSQL
- **🎯 Real-time Transcription** — OpenAI Whisper transcription for each audio chunk

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT (Browser)                          │
├─────────────────────────────────────────────────────────────────────┤
│  1. Record Audio → Chunk (5s segments)                              │
│  2. Save to OPFS (durable local storage)                            │
│  3. Get Presigned URL from API                                      │
│  4. Upload directly to S3 ─────────────────────────┐                │
│  5. Confirm upload to API                          │                │
│  6. Delete from OPFS after acknowledgment          │                │
└────────────────────────────────────────────────────│────────────────┘
                                                     │
                         ┌───────────────────────────▼────────────────┐
                         │              S3 / MinIO                    │
                         │         (Object Storage)                   │
                         └───────────────────────────────────────────┘
                                         ▲
┌────────────────────────────────────────│────────────────────────────┐
│                            API SERVER                               │
├────────────────────────────────────────│────────────────────────────┤
│  • Generate Presigned URLs             │                            │
│  • Track chunk status                  │                            │
│  • Rate limiting (Redis)               │                            │
│  • Reconciliation                      │                            │
└────────────────────────────────────────│────────────────────────────┘
           │                             │
           ▼                             ▼
┌─────────────────────┐    ┌─────────────────────────────────────────┐
│     Redis Cache     │    │         PostgreSQL Database             │
│  • Presigned URLs   │    │  • Recording sessions                   │
│  • Metadata cache   │    │  • Chunk status & checksums             │
│  • Rate limits      │    │  • Indexes for fast queries             │
└─────────────────────┘    └─────────────────────────────────────────┘
```

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | Next.js 16 + React | Recording UI, OPFS management |
| Backend | Hono + Bun | Fast API server |
| Database | PostgreSQL + Drizzle ORM | Session & chunk tracking |
| Cache | Redis | Rate limiting, presigned URL cache |
| Storage | S3 / MinIO | Audio file storage |
| Build | Turborepo | Monorepo management |

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ or **Bun** 1.0+
- **Docker** & Docker Compose
- **Git**

### 1. Clone & Install

```bash
git clone <repository-url>
cd swadesh-ai
npm install
```

### 2. Start Infrastructure

```bash
# Start PostgreSQL, Redis, and MinIO
docker compose up -d

# Wait for services to be healthy
docker compose ps
```

### 3. Configure Environment

```bash
# Copy example env file
cp apps/server/.env.example apps/server/.env

# Edit if needed (defaults work for local development)
```

### 4. Setup Database

```bash
# Push schema to PostgreSQL
npm run db:push
```

### 5. Run Development Server

```bash
npm run dev
```

**Access:**
- 🌐 Web App: http://localhost:3001
- 🔌 API Server: http://localhost:3000
- 📦 MinIO Console: http://localhost:9001 (minioadmin / minioadmin123)

## 📁 Project Structure

```
├── apps/
│   ├── server/              # Hono API server
│   │   ├── src/
│   │   │   ├── index.ts     # Server entry point
│   │   │   ├── routes/      # API routes
│   │   │   │   ├── recordings.ts
│   │   │   │   └── chunks.ts
│   │   │   ├── lib/
│   │   │   │   ├── storage.ts   # S3/Local storage
│   │   │   │   └── cache.ts     # Redis cache
│   │   │   └── middleware/
│   │   │       └── rate-limit.ts
│   │   └── .env
│   │
│   └── web/                 # Next.js frontend
│       └── src/
│           ├── app/
│           │   └── recorder/    # Recording page
│           ├── hooks/
│           │   └── use-recorder.ts
│           └── lib/
│               ├── opfs.ts      # OPFS utilities
│               └── chunk-upload.ts
│
├── packages/
│   ├── db/                  # Database schema & migrations
│   ├── env/                 # Environment validation
│   └── ui/                  # Shared UI components
│
├── docker-compose.yml       # Local infrastructure
└── README.md
```

## 🔌 API Endpoints

### Recordings

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/recordings` | Create recording session |
| `GET` | `/api/recordings/:id` | Get recording details |
| `POST` | `/api/recordings/:id/complete` | Mark recording complete |

### Chunks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/chunks/upload-url` | Get presigned URL for S3 upload |
| `POST` | `/api/chunks/upload` | Upload chunk (fallback) |
| `POST` | `/api/chunks/confirm-upload` | Confirm S3 upload completed |
| `POST` | `/api/chunks/ack` | Acknowledge chunk stored |
| `GET` | `/api/chunks/recording/:id` | List chunks for recording |
| `GET` | `/api/chunks/:id/playback-url` | Get playback URL |
| `POST` | `/api/chunks/reconcile` | Verify storage integrity |
| `GET` | `/api/chunks/:id/transcription` | Get chunk transcription |
| `POST` | `/api/chunks/:id/transcribe` | Retry transcription |
| `GET` | `/api/chunks/recording/:id/transcript` | Get full recording transcript |
| `GET` | `/api/chunks/transcription-status` | Check if transcription enabled |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Basic health check |
| `GET` | `/health` | Detailed health with service status |

## ⚙️ Configuration

### Environment Variables

```env
# Database (Required)
DATABASE_URL="postgresql://postgres:password@localhost:5432/recordings"

# CORS (Required)
CORS_ORIGIN="http://localhost:3001"

# S3 Storage
STORAGE_BUCKET_NAME="recordings"
STORAGE_ENDPOINT="http://localhost:9000"  # Remove for AWS S3
STORAGE_ACCESS_KEY="minioadmin"
STORAGE_SECRET_KEY="minioadmin123"
STORAGE_REGION="us-east-1"

# Redis Cache (Recommended)
REDIS_URL="redis://localhost:6379"

# Rate Limiting
RATE_LIMIT_REQUESTS=100  # Per minute
RATE_LIMIT_WINDOW=60     # Seconds

# CDN (Optional)
CDN_URL="https://d123456789.cloudfront.net"
```

## ☁️ AWS Deployment

### Infrastructure Required

| Service | Purpose | Estimated Cost |
|---------|---------|----------------|
| RDS PostgreSQL | Database | $15-50/mo |
| ElastiCache Redis | Caching | $15-30/mo |
| S3 | Object storage | $0.023/GB |
| CloudFront | CDN | $0.085/GB |
| ECS/Lambda | API hosting | $10-50/mo |

### Setup Steps

1. **Create S3 Bucket**
   ```bash
   aws s3 mb s3://your-recordings-bucket
   aws s3api put-bucket-cors --bucket your-recordings-bucket --cors-configuration file://cors.json
   ```

2. **Create RDS Instance**
   ```bash
   aws rds create-db-instance \
     --db-instance-identifier recordings-db \
     --db-instance-class db.t3.micro \
     --engine postgres \
     --master-username postgres \
     --master-user-password <password>
   ```

3. **Create ElastiCache Cluster**
   ```bash
   aws elasticache create-cache-cluster \
     --cache-cluster-id recordings-cache \
     --engine redis \
     --cache-node-type cache.t3.micro \
     --num-cache-nodes 1
   ```

4. **Update Environment Variables**
   ```env
   DATABASE_URL="postgresql://user:pass@rds-endpoint:5432/recordings"
   REDIS_URL="redis://elasticache-endpoint:6379"
   STORAGE_BUCKET_NAME="your-recordings-bucket"
   STORAGE_REGION="us-east-1"
   # Remove STORAGE_ENDPOINT for AWS S3
   ```

## 📊 Scalability

### Handling 1000 Concurrent Users

| Component | Strategy |
|-----------|----------|
| **API Servers** | Horizontally scale behind load balancer |
| **Database** | Read replicas, connection pooling (pgBouncer) |
| **Redis** | ElastiCache cluster mode |
| **S3** | Automatically scales, use presigned URLs |
| **Uploads** | Direct-to-S3 bypasses API servers |

### Performance Optimizations

1. **Presigned URLs** — Large uploads go directly to S3
2. **Redis Caching** — 5-min TTL on metadata, 14-min on URLs
3. **Database Indexes** — Optimized for common queries
4. **Compression** — Gzip on API responses
5. **Connection Pooling** — Reuse database connections

## 🧪 Testing

### Health Check

```bash
curl http://localhost:3000/health
```

### Create Recording

```bash
curl -X POST http://localhost:3000/api/recordings \
  -H "Content-Type: application/json" \
  -d '{"id":"test-123","clientId":"browser-1","sampleRate":16000}'
```

### Get Presigned URL

```bash
curl -X POST http://localhost:3000/api/chunks/upload-url \
  -H "Content-Type: application/json" \
  -d '{"recordingId":"test-123","chunkIndex":0,"chunkId":"chunk-001"}'
```

## 🔧 Development

### Database Management

```bash
npm run db:push      # Push schema changes
npm run db:studio    # Open Drizzle Studio
npm run db:generate  # Generate migrations
```

### Docker Commands

```bash
docker compose up -d     # Start services
docker compose logs -f   # View logs
docker compose down      # Stop services
docker compose down -v   # Stop & remove volumes
```

## 📝 License

MIT

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open Pull Request
| GET | `/api/chunks/recording/:recordingId` | Get all chunks for a recording |
| GET | `/api/chunks/needs-reupload/:recordingId` | Get chunks needing re-upload |
| POST | `/api/chunks/reconcile` | Verify and repair chunk storage |
| GET | `/api/chunks/:chunkId/status` | Get chunk status |

## Client-Side Pipeline

The recording pipeline uses OPFS (Origin Private File System) for durability:

```
Recording Start → Create Recording Session (DB)
       ↓
Audio Chunk Ready → Save to OPFS → Upload to Server → Acknowledge
       ↓
Recording Stop → Complete Recording → Clean up OPFS (after all acks)
```

### OPFS Storage

Chunks are stored in OPFS at:
```
/recordings/{recordingId}/chunks/chunk_000001.wav
/recordings/{recordingId}/metadata.json
```

### Recovery Flow

On page load or manual trigger:
1. Call `/api/chunks/reconcile` to check for missing chunks
2. If chunks are missing from storage but exist in OPFS, re-upload them
3. Clean up OPFS only after successful acknowledgment

## Load Testing

Target: **300,000 requests** to validate the chunking pipeline under heavy load.

### Setup

Use a load testing tool like [k6](https://k6.io), [autocannon](https://github.com/mcollina/autocannon), or [artillery](https://artillery.io) to simulate concurrent chunk uploads.

Example with **k6**:

```js
import http from "k6/http";
import { check } from "k6";
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  scenarios: {
    chunk_uploads: {
      executor: "constant-arrival-rate",
      rate: 5000,           // 5,000 req/s
      timeUnit: "1s",
      duration: "1m",       // → 300K requests in 60s
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
};

// Create a test recording first, then use its ID
const RECORDING_ID = "test-recording-id"; // Replace with actual recording ID

export default function () {
  const chunkId = uuidv4();
  const chunkIndex = __ITER;
  
  // Create dummy WAV data (1KB)
  const dummyData = "x".repeat(1024);
  
  const formData = {
    file: http.file(dummyData, `chunk_${chunkIndex}.wav`, "audio/wav"),
    chunkId: chunkId,
    recordingId: RECORDING_ID,
    chunkIndex: chunkIndex.toString(),
    duration: "5000",
  };

  const res = http.post("http://localhost:3000/api/chunks/upload", formData);

  check(res, {
    "upload status 200": (r) => r.status === 200,
  });

  // Acknowledge the chunk
  if (res.status === 200) {
    const ackRes = http.post(
      "http://localhost:3000/api/chunks/ack",
      JSON.stringify({ chunkId }),
      { headers: { "Content-Type": "application/json" } }
    );
    
    check(ackRes, {
      "ack status 200": (r) => r.status === 200,
    });
  }
}
```

Run:

```bash
k6 run load-test.js
```

### What to Validate

- **No data loss** — every ack in the DB has a matching chunk in the bucket
- **OPFS recovery** — chunks survive client disconnects and can be re-uploaded
- **Throughput** — server handles sustained 5K req/s without dropping chunks
- **Consistency** — reconciliation catches and repairs any bucket/DB mismatches after the run

## Project Structure

```
recoding-assignment/
├── apps/
│   ├── web/         # Frontend (Next.js) — chunking, OPFS, upload logic
│   └── server/      # Backend API (Hono) — bucket upload, DB ack
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── db/          # Drizzle ORM schema & queries
│   ├── env/         # Type-safe environment config
│   └── config/      # Shared TypeScript config
```

## Available Scripts

- `npm run dev` — Start all apps in development mode
- `npm run build` — Build all apps
- `npm run dev:web` — Start only the web app
- `npm run dev:server` — Start only the server
- `npm run check-types` — TypeScript type checking
- `npm run db:push` — Push schema changes to database
- `npm run db:generate` — Generate database client/types
- `npm run db:migrate` — Run database migrations
- `npm run db:studio` — Open database studio UI

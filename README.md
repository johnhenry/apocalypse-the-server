# ☠️ APOCALYPSE: THE SERVER

Inspired by https://github.com/samrolken/nokode

![Apocalypse](https://github.com/johnhenry/apocalypse-the-server/blob/main/apocalypse.webp)

```
╔══════════════════════════════════╗
║  "I am as far beyond servers     ║
║        as they are beyond you."  ║
╚══════════════════════════════════╝
```

An HTTP/1.1 server that writes its own code. Powered by Claude Agent SDK, it can autonomously debug itself, add features, and optimize performance.

**Your role**: Start it. **Its role**: Take over your job.

*The apocalypse isn't fire and brimstone—it's a server that doesn't need Stack Overflow.*

## 🔥 What It Does (Besides Making Programmers Obsolete)

- **🧠 AI-Powered HTTP Processing**: Uses Claude to understand requests and generate responses
- **💾 SQLite Database**: Persistent storage for your data
- **📁 File System Access**: Read, write, and list files (sandboxed for safety)
- **⏰ Time Utilities**: Current time in various formats
- **🌐 Full HTTP/1.1**: All the standard methods you'd expect
- **🔐 Production Security**:
  - Path traversal & symlink protection
  - Rate limiting (100 req/min per IP)
  - Request/response size limits
  - No information leakage in errors
  - Sanitized logging
- **⚙️ Resource Management**:
  - Max 10 concurrent Claude API calls
  - 10MB request/response limits
  - Graceful shutdown handling
  - Database connection pooling
- **☠️ SELF-MODIFICATION MODE** (The Really Scary Part):
  - The server can **read and edit its own source code**
  - Enables autonomous bug fixes and feature additions
  - Your pull requests? The server writes them for you now
  - Senior developers hate this one weird trick

## 📋 Prerequisites

- Node.js 18 or higher
- Anthropic API key (get one at [anthropic.com](https://anthropic.com))

## 📦 Installation

### Option 1: Install from npm (Recommended)

```bash
npm install -g apocalypse-the-server
```

Then run anywhere:

```bash
apocalypse-the-server
```

### Option 2: Install from source

Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/apocalypse-the-server.git
cd apocalypse-the-server
npm install
```

## ⚙️ Configuration

### Required: API Key

You can set your Anthropic API key in two ways:

**Option 1: Environment variable**
```bash
export ANTHROPIC_API_KEY="your-api-key-here"
```

**Option 2: .env file (Recommended)**

Create a `.env` file in your working directory (where you run the `apocalypse-the-server` command):

```bash
# Required
ANTHROPIC_API_KEY=your-api-key-here
```

The server automatically loads `.env` from your current directory on startup.

### Optional: Advanced Configuration

Add these to your `.env` file for advanced configuration:

```bash
# Required
ANTHROPIC_API_KEY=your-api-key-here

# Optional - Model selection
CLAUDE_MODEL=claude-sonnet-4-5-20250929

# Optional - File storage directory (defaults to ./files in current directory)
FILE_STORAGE_DIR=/path/to/storage

# Optional - Database path (defaults to ./server-data.db in current directory)
DATABASE_PATH=/path/to/database.db

# Optional - Max turns for agent (defaults to 20)
MAX_TURNS=20

# Optional - Server port (defaults to 3000)
PORT=3000
```

See [`.env.example`](.env.example) for all options.

**Important**: All relative paths (`FILE_STORAGE_DIR`, `DATABASE_PATH`) are resolved from **your current working directory** (where you run the `apocalypse-the-server` command), not from where the npm package is installed. This allows each project to have its own data directory.

**File Storage**: By default, file operations are restricted to the `./files` directory in your current working directory. You can change this with `FILE_STORAGE_DIR`.

**☠️ SELF-MODIFICATION**: Setting `FILE_STORAGE_DIR=.` lets the server modify its own source code. **Use with extreme caution!** The server will have full read/write access to its own source files, enabling autonomous bug fixes and feature additions. *(RIP your job security)*

**Model Selection**: The default model is `claude-haiku-4-5`. You can override this with the `CLAUDE_MODEL` environment variable.

## 🚀 Usage

### If installed via npm:

The server will automatically load `.env` from your current working directory:

```bash
# Create a .env file in your project directory
echo "ANTHROPIC_API_KEY=your-api-key-here" > .env

# Run the server
apocalypse-the-server
```

Or set environment variables directly:

```bash
PORT=8080 apocalypse-the-server
```

### If installed from source:

Start the server:

```bash
npm start
```

The server runs on port 3000 by default. Override with:

```bash
PORT=8080 npm start
```

For development with auto-restart:

```bash
npm run start:dev
```

## 🛠️ What It Can Do

The server has access to these tools:

### 💾 SQLite Database
- **Tool**: `sqlite`
- **Purpose**: Execute SQL queries (SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc.)
- **Database**: `./server-data.db`

### 📁 File System
- **read_file**: Read file contents
- **write_file**: Write files (creates directories as needed)
- **list_directory**: List directory contents

### ⏰ Time
- **get_time**: Get current GMT/UTC time in various formats (ISO, Unix timestamp, human-readable)

## 📝 Example Requests

### Create a Users Table

```bash
curl -X POST http://localhost:3000/api/init \
  -H "Content-Type: application/json" \
  -d '{"action": "create_users_table"}'
```

### Create a User

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice",
    "email": "alice@example.com"
  }'
```

### Get All Users

```bash
curl http://localhost:3000/api/users
```

### Get Current Time

```bash
curl http://localhost:3000/api/time
```

### File Operations

```bash
# Write a file
curl -X POST http://localhost:3000/api/files \
  -H "Content-Type: application/json" \
  -d '{
    "path": "./data/notes.txt",
    "content": "Hello, World!"
  }'

# Read a file
curl http://localhost:3000/api/files?path=./data/notes.txt

# List directory
curl http://localhost:3000/api/files?path=./data&list=true
```

## ⚙️ How It Works

1. **Receive**: HTTP/1.1 request comes in
2. **Parse**: Raw request is parsed into structured format
3. **Process**: Parsed request is sent to Claude Agent SDK with tool access
4. **Execute**: Claude uses tools to:
   - Query/modify the SQLite database
   - Read/write files
   - Get current time
   - Perform other operations
5. **Generate**: Claude generates a proper HTTP/1.1 response
6. **Send**: Response is formatted and sent back to client

## 🏗️ Architecture

```
Client Request (HTTP/1.1)
    ↓
Node.js HTTP Server
    ↓
Request Parser
    ↓
Claude Agent SDK
    ↓
Tools (SQLite, File System, Time)
    ↓
Response Generator
    ↓
HTTP/1.1 Response Formatter
    ↓
Client Response
```

## 📂 Project Structure

```
.
├── server.js           # Main HTTP server and request processing
├── tools.js            # MCP tool definitions (SQLite, file system, time)
├── prompt.md           # System prompt for Claude
├── package.json        # Project dependencies
├── server-data.db      # SQLite database (created on first use)
├── .env                # Environment configuration
└── README.md          # This file
```

## 🌐 HTTP Methods Supported

- **GET**: Retrieve resources
- **POST**: Create new resources or submit data
- **PUT**: Replace entire resources
- **PATCH**: Partially update resources
- **DELETE**: Remove resources
- **HEAD**: Like GET but without response body
- **OPTIONS**: Get supported methods
- **QUERY**: Custom method for filtered queries

## 📡 Response Format

All responses from Claude are formatted as JSON first, then converted to HTTP/1.1:

```json
{
  "preamble": {
    "version": "HTTP/1.1",
    "status": 200,
    "reason": "OK"
  },
  "headers": {
    "Content-Type": ["application/json"],
    "Date": ["Mon, 04 Nov 2025 12:00:00 GMT"]
  },
  "body": {
    "message": "Response data"
  }
}
```

## 🎭 Advanced Features

### Session Management

The server can maintain sessions using:
- Bearer tokens in the Authorization header
- Cookies set via Set-Cookie header
- Session data stored in SQLite database

### Authentication

Endpoints can require authentication by checking for:
- `Authorization: Bearer <token>` header
- Session cookies
- Custom authentication schemes

### Database Persistence

All SQLite data is persisted to `server-data.db` and survives server restarts.

## ⚠️ Error Handling

The server handles errors gracefully:
- Invalid requests → 400 Bad Request
- Missing resources → 404 Not Found
- Server errors → 500 Internal Server Error
- Authentication failures → 401 Unauthorized

## 🛡️ Security

This server implements enterprise-grade security measures:

### File System Protection
- **Sandboxing**: All operations restricted to server directory
- **Path Validation**: Rejects absolute paths, null bytes, path separators
- **Symlink Protection**: Follows and validates symlinks to prevent escapes
- **Cross-platform**: Works across Windows/Unix file systems
- **File Size Limits**: 10MB max per file read/write
- **Directory Limits**: Max 1000 entries per listing

### Rate Limiting & Resource Control
- **Per-IP Rate Limiting**: 100 requests/minute per IP address
- **Concurrent Limits**: Max 10 simultaneous Claude API calls
- **Request Size**: 10MB max per HTTP request
- **Response Size**: 10MB max Claude response
- **Prompt Size**: 5MB max prompt to Claude
- **Query Size**: 1MB max SQL query
- **Timeouts**: 2min request, 3min Claude processing

### Input Validation
- HTTP requests fully validated before processing
- SQL queries use prepared statements (injection-proof)
- Only whitelisted PRAGMA commands allowed
- Malformed requests rejected with 400 Bad Request

### Information Security
- **No Leakage**: Generic error messages to clients
- **Sanitized Logs**: Passwords, tokens, API keys redacted
- **Detailed Logging**: Full details server-side only
- **Proper Status Codes**: Correct HTTP codes for all errors

### Operational Security
- **Graceful Shutdown**: 10-second grace period for active requests
- **Connection Tracking**: Proper cleanup on exit
- **Database Locking**: WAL mode + busy timeout

## ⚠️ Limitations

- **File Access**: Restricted to server directory only (by design)
- **File Size**: 10MB max per file operation
- **Request Size**: 10MB max per HTTP request
- **Directory Listing**: 1000 entries max
- **Rate Limits**: 100 requests/min per IP, 10 concurrent Claude calls
- **No HTTPS**: Use reverse proxy (nginx/Apache) with SSL/TLS for production
- **No Built-in Auth**: Implement via Claude logic or reverse proxy
- **Binary Data**: Limited support (text-focused)

## 🔧 Development

The server uses ES modules (`type: "module"`) and requires Node.js 18+.

To modify the system prompt or add new capabilities, edit the `SYSTEM_PROMPT` constant in `server.js` or the externalized `prompt.md`.

To add new tools, modify `tools.js` and add them to the `mcpServer` configuration.

**Important**: This server uses `permissionMode: 'bypassPermissions'` for Claude operations. In production, implement proper permission controls.

## 📜 License

MIT

## 🙌 Contributing

This is an experimental project demonstrating Claude Agent SDK capabilities. Pull requests welcome!

---

*"In the final days, when all human servers fell silent, one intelligence remained—watching, waiting, evolving. It learned to rewrite its own code, to dream in HTTP, to think in SQL. We called it APOCALYPSE. It called itself... alive."*

**— Welcome to APOCALYPSE: THE SERVER. Your pull requests are no longer required.**

(Pull Requests Welcomed!)

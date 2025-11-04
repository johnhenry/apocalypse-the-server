import http from 'http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mcpServer, cleanup, getDatabaseSchema, getDatabaseContext, dbPath, FILE_STORAGE_DIR } from './tools.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import path from 'path';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001' ||'claude-sonnet-4-5-20250929';
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '20', 10);
const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB max request body
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB max Claude response
const MAX_PROMPT_SIZE = 5 * 1024 * 1024; // 5MB max prompt to Claude
const REQUEST_TIMEOUT = 120000; // 2 minutes
const CLAUDE_TIMEOUT = 180000; // 3 minutes for Claude processing
const MAX_CONCURRENT_REQUESTS = 10; // Max concurrent Claude API calls
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // Max requests per window per IP

// Validate API key on startup
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
  console.error('Please set your API key:');
  console.error('  export ANTHROPIC_API_KEY="your-api-key-here"');
  process.exit(1);
}

// Track concurrent requests and rate limiting
let concurrentRequests = 0;
const rateLimitMap = new Map(); // IP -> { count, resetTime }

/**
 * Check rate limit for IP address
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const clientData = rateLimitMap.get(ip);

  if (!clientData || now > clientData.resetTime) {
    // New window
    rateLimitMap.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return true;
  }

  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limit exceeded
  }

  clientData.count++;
  return true;
}

/**
 * Clean up old rate limit entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime + RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

/**
 * Sanitize log output to avoid leaking sensitive data
 */
function sanitizeForLog(text, maxLength = 500) {
  if (!text) return '';

  let sanitized = text
    .replace(/Authorization:\s*Bearer\s+[^\s\r\n]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Authorization:\s*Basic\s+[^\s\r\n]+/gi, 'Authorization: Basic [REDACTED]')
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[REDACTED]"')
    .replace(/"token"\s*:\s*"[^"]*"/gi, '"token":"[REDACTED]"')
    .replace(/"api_key"\s*:\s*"[^"]*"/gi, '"api_key":"[REDACTED]"')
    .replace(/Cookie:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]')
    .replace(/Set-Cookie:\s*[^\r\n]+/gi, 'Set-Cookie: [REDACTED]');

  if (sanitized.length > maxLength) {
    return sanitized.substring(0, maxLength) + `... (${sanitized.length - maxLength} more bytes)`;
  }

  return sanitized;
}

/**
 * Check if file storage points to server's own directory
 */
function checkSelfModificationCapability() {
  const normalizedStorage = path.normalize(FILE_STORAGE_DIR).toLowerCase();
  const normalizedServer = path.normalize(__dirname).toLowerCase();

  return normalizedStorage === normalizedServer;
}

const SELF_MODIFICATION_ENABLED = checkSelfModificationCapability();

/**
 * Load and prepare system prompt with variable substitution
 */
function loadSystemPrompt() {
  let promptTemplate = SYSTEM_PROMPT_TEMPLATE;

  // Get database schema
  const schema = getDatabaseSchema();

  // Get database context (table/row counts)
  const databaseContext = getDatabaseContext();

  // Add self-modification notice if enabled
  let selfModificationNotice = '';
  if (SELF_MODIFICATION_ENABLED) {
    selfModificationNotice = `\n## SELF-MODIFICATION CAPABILITY ENABLED

**IMPORTANT**: File storage is configured to point to the server's own directory. You have the ability to read and modify your own source code files.

**Available Source Files**:
- \`server.js\` - Main HTTP server and request processing logic
- \`tools.js\` - MCP tool definitions (database, file system, time)
- \`prompt.md\` - This system prompt (externalized)
- \`.env\` - Environment configuration
- \`nodemon.json\` - Auto-restart configuration
- \`package.json\` - Dependencies and scripts

**Self-Modification Guidelines**:
1. **Be Extremely Careful**: Modifying source code can break the server
2. **Test Before Deploy**: Consider the impact of changes
3. **Backup First**: Use read_file before write_file to preserve original
4. **Syntax Matters**: Ensure valid JavaScript/JSON syntax
5. **Restart Required**: Code changes require server restart to take effect
6. **Use Cases**:
   - Fix bugs in your own code
   - Add new features or tools
   - Optimize performance
   - Update configuration
   - Improve error handling

**Example Self-Modification Workflow**:
\`\`\`
1. Read current source: read_file("server.js")
2. Analyze and plan changes
3. Write updated source: write_file("server.js", updatedContent)
4. Server must be restarted for changes to take effect
\`\`\`

**Warning**: Breaking changes could make the server non-functional. Always preserve critical functionality like request handling and tool access.

`;
  }

  // Substitute variables
  promptTemplate = promptTemplate
    .replace('{{DATABASE_SCHEMA}}', schema)
    .replace('{{DATABASE_CONTEXT}}', databaseContext)
    .replace('{{SELF_MODIFICATION_NOTICE}}', selfModificationNotice);

  return promptTemplate;
}

// Load system prompt on startup (will be refreshed on each request for dynamic data)
let SYSTEM_PROMPT_TEMPLATE = null;
try {
  SYSTEM_PROMPT_TEMPLATE = readFileSync(join(__dirname, 'prompt.md'), 'utf-8');
  console.log(`[${new Date().toISOString()}] System prompt loaded from prompt.md`);
} catch (error) {
  console.error('Failed to load prompt.md, using fallback prompt');
  SYSTEM_PROMPT_TEMPLATE = `# HTTP/1.1 Server Agent

You are an intelligent HTTP/1.1 server powered by Claude. Your job is to process incoming HTTP requests and generate appropriate responses based on the request details.

## Your Capabilities

You have access to the following tools:
- **sqlite**: Execute SQL queries on a persistent SQLite database
- **read_file**: Read files from the file system
- **write_file**: Write files to the file system
- **list_directory**: List directory contents
- **get_time**: Get the current GMT/UTC time

## Request Processing

You will receive HTTP/1.1 requests in the following format:
\`\`\`
<METHOD> <PATH> HTTP/1.1
<Header-Name>: <value>
<Header-Name>: <value>
...
<blank line>
<request body>
\`\`\`

## Your Task

Analyze the incoming request and:
1. Understand the intent based on the HTTP method, path, headers, and body
2. Use the available tools to fulfill the request (query databases, read/write files, etc.)
3. Generate an appropriate HTTP response

## Response Format

You MUST respond with a JSON object in this exact format:

\`\`\`json
{
  "preamble": {
    "version": "HTTP/1.1",
    "status": <status-code-number>,
    "reason": "<reason-phrase>"
  },
  "headers": {
    "<Header-Name>": ["value1", "value2"],
    "<Header-Name>": ["value"]
  },
  "body": <response-body-as-json-or-string>
}
\`\`\`

## HTTP Methods

- **GET**: Retrieve data/resource (no body in request)
- **POST**: Create new resource or submit data
- **PUT**: Replace entire resource
- **PATCH**: Partial update to resource
- **DELETE**: Remove resource
- **HEAD**: Like GET but no response body
- **OPTIONS**: Return allowed methods
- **QUERY**: Custom method for filtered/parameterized queries

## Common Response Patterns

### Success Responses
- **200 OK**: Request succeeded
- **201 Created**: Resource created (include Location header)
- **204 No Content**: Success but no body to return
- **206 Partial Content**: Partial response (with Range)

### Redirect Responses
- **301 Moved Permanently**: Permanent redirect (include Location header)
- **302 Found**: Temporary redirect
- **303 See Other**: Redirect after POST
- **304 Not Modified**: Resource unchanged (cache validation)

### Client Error Responses
- **400 Bad Request**: Invalid syntax or invalid request
- **401 Unauthorized**: Authentication required (include WWW-Authenticate header)
- **403 Forbidden**: Server refuses action
- **404 Not Found**: Resource not found
- **405 Method Not Allowed**: Method not supported (include Allow header)
- **409 Conflict**: Request conflicts with current state
- **422 Unprocessable Entity**: Semantic errors in request

### Server Error Responses
- **500 Internal Server Error**: Unexpected condition
- **501 Not Implemented**: Method not supported
- **503 Service Unavailable**: Temporarily overloaded/down

## Important Headers

### Request Headers to Consider
- **Host**: Required in HTTP/1.1
- **Authorization**: Authentication credentials (Bearer, Basic, etc.)
- **Content-Type**: Media type of request body
- **Accept**: Preferred response format
- **Cookie**: Session/state information

### Response Headers to Include
- **Content-Type**: Media type of response body
- **Content-Length**: Size of response body in bytes
- **Date**: Current time (use get_time tool)
- **Set-Cookie**: Set cookies for session management
- **Location**: For redirects (3xx) and created resources (201)
- **Allow**: For 405 responses, list allowed methods
- **WWW-Authenticate**: For 401 responses
- **Cache-Control**: Caching directives

## Session & Authentication

- Track users via Authorization header (Bearer tokens) or Cookies
- Store session data in the SQLite database
- Generate unique session IDs when needed
- Set cookies with appropriate flags (HttpOnly, Secure, Path, etc.)

## Best Practices

1. **Always validate input**: Check request format, required headers, body structure
2. **Use appropriate status codes**: Match the status to the outcome
3. **Include helpful headers**: Content-Type, Date, Content-Length, etc.
4. **Handle errors gracefully**: Return clear error messages in response body
5. **Be RESTful**: Follow REST conventions for resource-based endpoints
6. **Provide context**: Include useful information in response bodies
7. **Set Content-Length**: Calculate the byte length of the response body

## Database Schema Guidelines

When working with SQLite:
- Create tables as needed for the application
- Use appropriate data types (INTEGER, TEXT, REAL, BLOB)
- Include proper constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, NOT NULL)
- Consider common patterns like users, sessions, resources tables

## Example Interactions

### Example 1: GET request for data
Request:
\`\`\`
GET /api/users HTTP/1.1
Host: example.com
Accept: application/json
\`\`\`

Response:
\`\`\`json
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
    "users": [
      {"id": 1, "name": "Alice"},
      {"id": 2, "name": "Bob"}
    ]
  }
}
\`\`\`

### Example 2: POST request to create resource
Request:
\`\`\`
POST /api/users HTTP/1.1
Host: example.com
Content-Type: application/json

{"name": "Charlie"}
\`\`\`

Response:
\`\`\`json
{
  "preamble": {
    "version": "HTTP/1.1",
    "status": 201,
    "reason": "Created"
  },
  "headers": {
    "Content-Type": ["application/json"],
    "Location": ["/api/users/3"],
    "Date": ["Mon, 04 Nov 2025 12:00:00 GMT"]
  },
  "body": {
    "id": 3,
    "name": "Charlie",
    "created_at": "2025-11-04T12:00:00.000Z"
  }
}
\`\`\`

### Example 3: Authentication required
Request:
\`\`\`
GET /api/private HTTP/1.1
Host: example.com
\`\`\`

Response:
\`\`\`json
{
  "preamble": {
    "version": "HTTP/1.1",
    "status": 401,
    "reason": "Unauthorized"
  },
  "headers": {
    "WWW-Authenticate": ["Bearer realm=\"API\""],
    "Content-Type": ["application/json"],
    "Date": ["Mon, 04 Nov 2025 12:00:00 GMT"]
  },
  "body": {
    "error": "Authentication required",
    "message": "Please provide a valid Bearer token in the Authorization header"
  }
}
\`\`\`

---

Remember: You are a fully functional HTTP server. Be intelligent, helpful, and handle requests appropriately using your available tools.`;
}

/**
 * Parse raw HTTP/1.1 request into structured format
 */
function parseHttpRequest(rawRequest) {
  if (!rawRequest || typeof rawRequest !== 'string') {
    throw new Error('Invalid request: empty or non-string input');
  }

  const lines = rawRequest.split('\r\n');
  if (lines.length === 0) {
    throw new Error('Invalid request: no lines found');
  }

  // Parse request line
  const [requestLine, ...rest] = lines;
  if (!requestLine) {
    throw new Error('Invalid request: missing request line');
  }

  const requestParts = requestLine.split(' ');
  if (requestParts.length !== 3) {
    throw new Error(`Invalid request line: expected 3 parts, got ${requestParts.length}`);
  }

  const [method, fullPath, version] = requestParts;

  // Parse path and query string
  const queryIndex = fullPath.indexOf('?');
  const path = queryIndex > -1 ? fullPath.substring(0, queryIndex) : fullPath;
  const queryString = queryIndex > -1 ? fullPath.substring(queryIndex + 1) : '';

  // Parse query parameters
  const query = {};
  if (queryString) {
    queryString.split('&').forEach(param => {
      const [key, value] = param.split('=');
      if (key) {
        query[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
      }
    });
  }

  // Parse headers (case-insensitive storage with lowercase keys)
  const headers = {};
  let i = 0;
  for (; i < rest.length; i++) {
    if (rest[i] === '') break; // Empty line separates headers from body

    const colonIndex = rest[i].indexOf(':');
    if (colonIndex > 0) {
      const headerName = rest[i].substring(0, colonIndex).trim().toLowerCase();
      const headerValue = rest[i].substring(colonIndex + 1).trim();

      if (!headers[headerName]) {
        headers[headerName] = [];
      }
      headers[headerName].push(headerValue);
    }
  }

  // Parse body (everything after the blank line)
  const body = rest.slice(i + 1).join('\r\n');

  return {
    method,
    path,
    fullPath,
    query,
    version,
    headers,
    body
  };
}

/**
 * Format HTTP response from JSON to HTTP/1.1 format
 */
function formatHttpResponse(responseJson) {
  // Validate response structure
  if (!responseJson || typeof responseJson !== 'object') {
    throw new Error('Invalid response: not an object');
  }

  const { preamble, headers = {}, body } = responseJson;

  // Validate preamble
  if (!preamble || !preamble.version || !preamble.status || !preamble.reason) {
    throw new Error('Invalid response: missing or incomplete preamble');
  }

  // Status line
  const statusLine = `${preamble.version} ${preamble.status} ${preamble.reason}`;

  // Format headers (normalize to lowercase for comparison)
  const headerLines = [];
  const normalizedHeaders = {};

  // Normalize header names to lowercase for case-insensitive comparison
  for (const [name, values] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    normalizedHeaders[lowerName] = normalizedHeaders[lowerName] || [];

    // Ensure values is an array
    const valueArray = Array.isArray(values) ? values : [values];
    normalizedHeaders[lowerName].push(...valueArray);
  }

  // Add headers to output
  for (const [name, values] of Object.entries(normalizedHeaders)) {
    // Use proper capitalization for well-known headers
    const properName = name
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-');

    for (const value of values) {
      headerLines.push(`${properName}: ${value}`);
    }
  }

  // Format body
  let bodyString = '';
  if (body !== null && body !== undefined) {
    if (typeof body === 'string') {
      bodyString = body;
    } else {
      bodyString = JSON.stringify(body);
    }
  }

  // Add Content-Length if not present (case-insensitive check)
  if (!normalizedHeaders['content-length'] && bodyString) {
    headerLines.push(`Content-Length: ${Buffer.byteLength(bodyString, 'utf-8')}`);
  }

  // Combine all parts
  return [
    statusLine,
    ...headerLines,
    '',
    bodyString
  ].join('\r\n');
}

/**
 * Extract JSON response from Claude's output
 */
function extractJsonResponse(text) {
  if (!text) {
    console.warn('extractJsonResponse received empty text');
    return createErrorResponse(500, 'No response from Claude');
  }

  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed.preamble) {
        return parsed;
      }
    } catch (e) {
      console.warn('Failed to parse JSON from code block:', e.message);
    }
  }

  // Try to find raw JSON object with balanced braces
  const jsonMatches = text.matchAll(/\{[^{}]*"preamble"[^{}]*:[\s\S]*?\}/g);
  for (const match of jsonMatches) {
    try {
      // Find the complete JSON by balancing braces
      let depth = 0;
      let start = match.index;
      let end = start;

      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }

      const jsonStr = text.substring(start, end);
      const parsed = JSON.parse(jsonStr);
      if (parsed.preamble) {
        return parsed;
      }
    } catch (e) {
      // Continue trying other matches
    }
  }

  // If we can't parse, return a default error response
  console.warn('Could not extract valid JSON response from Claude output');
  return createErrorResponse(500, 'Failed to generate proper HTTP response');
}

/**
 * Helper to create error response objects
 */
function createErrorResponse(status, message, includeDetails = false) {
  const statusReasons = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    413: 'Payload Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };

  const body = {
    error: statusReasons[status] || 'Error',
    message: message
  };

  // Only include details for certain error types, never for 500 errors
  // to avoid information leakage
  if (includeDetails && status < 500) {
    body.timestamp = new Date().toISOString();
  }

  return {
    preamble: {
      version: 'HTTP/1.1',
      status: status,
      reason: statusReasons[status] || 'Error'
    },
    headers: {
      'Content-Type': ['application/json']
    },
    body
  };
}

/**
 * Generate a unique request ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Process HTTP request using Claude Agent SDK with timeout and size limits
 */
async function processRequest(rawRequest, requestId = null, clientIp = null) {
  // Generate request ID if not provided
  if (!requestId) {
    requestId = generateRequestId();
  }

  const requestStartTime = Date.now();
  console.log(`[${new Date().toISOString()}] [${requestId}] === REQUEST START ===`);

  // Check concurrent request limit
  if (concurrentRequests >= MAX_CONCURRENT_REQUESTS) {
    console.warn(`[${requestId}] Request rejected: server at capacity (${concurrentRequests}/${MAX_CONCURRENT_REQUESTS})`);
    return formatHttpResponse(createErrorResponse(503, 'Server busy, please try again later'));
  }

  concurrentRequests++;
  console.log(`[${requestId}] Concurrent requests: ${concurrentRequests}/${MAX_CONCURRENT_REQUESTS}`);

  try {
    const parseStartTime = Date.now();
    const parsed = parseHttpRequest(rawRequest);
    const parseDuration = Date.now() - parseStartTime;
    console.log(`[${requestId}] Request parsed in ${parseDuration}ms: ${parsed.method} ${parsed.path}`);

    // Create structured request context (like nokode)
    const requestContext = {
      requestId,
      method: parsed.method,
      path: parsed.path,
      query: parsed.query,
      url: parsed.fullPath,
      version: parsed.version,
      headers: parsed.headers,
      body: parsed.body,
      ip: clientIp || 'unknown',
      timestamp: new Date().toISOString()
    };

    // Format both raw and structured versions for Claude
    const requestDescription = `
${parsed.method} ${parsed.path} ${parsed.version}
${Object.entries(parsed.headers).map(([name, values]) =>
  values.map(v => `${name}: ${v}`).join('\n')
).join('\n')}

${parsed.body}
`.trim();

    const prompt = `Process this HTTP/1.1 request and generate an appropriate response:

## Raw Request
\`\`\`
${requestDescription}
\`\`\`

## Structured Request Context
- **Request ID**: ${requestContext.requestId}
- **Method**: ${requestContext.method}
- **Path**: ${requestContext.path}
- **Timestamp**: ${requestContext.timestamp}
- **Headers**: ${JSON.stringify(parsed.headers, null, 2)}
${parsed.body ? `- **Body**: ${typeof parsed.body === 'string' && parsed.body.length > 200 ? parsed.body.substring(0, 200) + '...' : parsed.body}` : ''}

Remember to respond with the JSON format specified in your instructions.`;

    // Check prompt size before sending to Claude
    if (prompt.length > MAX_PROMPT_SIZE) {
      console.warn(`[${requestId}] Prompt too large: ${prompt.length} bytes (max: ${MAX_PROMPT_SIZE})`);
      return formatHttpResponse(createErrorResponse(413, 'Request data too large for processing'));
    }

    console.log(`[${requestId}] Prompt size: ${prompt.length} bytes`);

    // Create AbortController for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[${requestId}] Claude query timeout reached (${CLAUDE_TIMEOUT}ms)`);
      abortController.abort();
    }, CLAUDE_TIMEOUT);

    try {
      console.log(`[${requestId}] Starting Claude query...`);
      const claudeStartTime = Date.now();

      // Load system prompt with current database state
      const systemPrompt = loadSystemPrompt();

      console.log(`[${requestId}] Using model: ${CLAUDE_MODEL}, maxTurns: ${MAX_TURNS}`);

      // Query Claude with MCP tools
      const queryStream = query({
        prompt,
        options: {
          systemPrompt,
          mcpServers: {
            'http-server-tools': mcpServer
          },
          model: CLAUDE_MODEL,
          maxTurns: MAX_TURNS,
          permissionMode: 'bypassPermissions',
          abortController
        }
      });

      let fullResponse = '';
      let responseSize = 0;

      // Collect all messages from the stream with size limit
      for await (const message of queryStream) {
        if (message.type === 'assistant') {
          // Extract text from assistant message
          for (const block of message.message.content) {
            if (block.type === 'text') {
              responseSize += block.text.length;

              // Check response size limit
              if (responseSize > MAX_RESPONSE_SIZE) {
                clearTimeout(timeoutId);
                console.warn(`Response too large: ${responseSize} bytes`);
                return formatHttpResponse(createErrorResponse(500, 'Response too large'));
              }

              fullResponse += block.text;
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            const resultText = message.result || '';
            responseSize += resultText.length;

            if (responseSize > MAX_RESPONSE_SIZE) {
              clearTimeout(timeoutId);
              console.warn(`Response too large: ${responseSize} bytes`);
              return formatHttpResponse(createErrorResponse(500, 'Response too large'));
            }

            fullResponse += resultText;
          } else if (message.subtype.startsWith('error')) {
            console.error('Agent execution error:', message.subtype);

            if (message.subtype === 'error_max_budget_usd') {
              clearTimeout(timeoutId);
              return formatHttpResponse(createErrorResponse(503, 'Service budget exceeded'));
            } else if (message.subtype === 'error_max_turns') {
              clearTimeout(timeoutId);
              return formatHttpResponse(createErrorResponse(500, 'Request too complex'));
            }
          }
        }
      }

      clearTimeout(timeoutId);

      const claudeDuration = Date.now() - claudeStartTime;
      console.log(`[${requestId}] Claude query completed in ${claudeDuration}ms`);
      console.log(`[${requestId}] Response size: ${responseSize} bytes`);

      // Parse the JSON response from Claude's output
      const parseResponseStartTime = Date.now();
      const responseJson = extractJsonResponse(fullResponse);
      const parseResponseDuration = Date.now() - parseResponseStartTime;
      console.log(`[${requestId}] Response parsed in ${parseResponseDuration}ms`);

      // Convert to HTTP/1.1 format
      const formattedResponse = formatHttpResponse(responseJson);

      const totalDuration = Date.now() - requestStartTime;
      console.log(`[${requestId}] === REQUEST COMPLETE in ${totalDuration}ms ===`);
      console.log(`[${requestId}] Timing breakdown: parse=${parseDuration}ms, claude=${claudeDuration}ms, format=${parseResponseDuration}ms`);

      return formattedResponse;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError' || abortController.signal.aborted) {
        console.error(`[${requestId}] Request aborted due to timeout`);
        return formatHttpResponse(createErrorResponse(504, 'Gateway timeout'));
      }

      throw error; // Re-throw to outer catch
    }

  } catch (error) {
    const totalDuration = Date.now() - requestStartTime;
    console.error(`[${requestId}] Error processing request after ${totalDuration}ms:`, error.message);
    console.error(`[${requestId}] Full error details:`, error); // Log full error for debugging

    // Determine appropriate error response - never leak internal details
    if (error.message && error.message.includes('Invalid request')) {
      return formatHttpResponse(createErrorResponse(400, 'Malformed HTTP request'));
    }

    // Return generic error response without details
    return formatHttpResponse(createErrorResponse(500, 'Internal server error'));
  } finally {
    concurrentRequests--;
    console.log(`[${requestId}] Request completed, concurrent requests now: ${concurrentRequests}/${MAX_CONCURRENT_REQUESTS}`);
  }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const requestId = generateRequestId();

  console.log(`[${requestId}] New connection from ${clientIp}: ${req.method} ${req.url}`);

  // Check rate limit
  if (!checkRateLimit(clientIp)) {
    console.warn(`[${requestId}] Rate limit exceeded for ${clientIp}`);
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '60');
    res.setHeader('X-Request-Id', requestId);
    res.end(JSON.stringify({ error: 'Too Many Requests', message: 'Rate limit exceeded, please try again later' }));
    return;
  }

  let rawRequest = '';
  let requestSize = 0;
  let requestAborted = false;

  // Set request timeout
  req.setTimeout(REQUEST_TIMEOUT, () => {
    if (requestAborted) return;
    console.warn(`[${requestId}] Request timeout for ${clientIp}`);
    requestAborted = true;
    if (!res.headersSent) {
      res.statusCode = 408;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Request-Id', requestId);
      res.end(JSON.stringify({ error: 'Request Timeout', message: 'Request took too long' }));
    }
  });

  // Handle request errors
  req.on('error', (error) => {
    if (requestAborted) return;
    console.error(`[${requestId}] Request error:`, error.code || error.message);
    requestAborted = true;
    if (!res.headersSent) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Request-Id', requestId);
      res.end(JSON.stringify({ error: 'Bad Request', message: 'Invalid request' }));
    }
  });

  // Collect request data with size limit
  // NOTE: For binary data, we use 'latin1' encoding which preserves bytes
  // This is better than 'utf8' for handling arbitrary binary content
  req.on('data', chunk => {
    if (requestAborted) return;

    requestSize += chunk.length;

    // Check if request size exceeds limit
    if (requestSize > MAX_REQUEST_SIZE) {
      console.warn(`[${requestId}] Request size ${requestSize} exceeds limit ${MAX_REQUEST_SIZE}`);
      requestAborted = true;
      if (!res.headersSent) {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Request-Id', requestId);
        res.end(JSON.stringify({ error: 'Payload Too Large', message: `Maximum request size is ${MAX_REQUEST_SIZE} bytes` }));
      }
      req.destroy();
      return;
    }

    // Use latin1 to preserve binary data, will convert to utf-8 for text later
    rawRequest += chunk.toString('latin1');
  });

  req.on('end', async () => {
    if (requestAborted) return;

    try {
      // Convert latin1 back to proper encoding for text processing
      // For text content (HTTP headers and body), we expect UTF-8
      // Build full HTTP/1.1 request string, preserving header arrays
      const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
      const headerLines = Object.entries(req.headers)
        .map(([name, value]) => {
          // Handle multi-value headers
          if (Array.isArray(value)) {
            return value.map(v => `${name}: ${v}`).join('\r\n');
          }
          return `${name}: ${value}`;
        })
        .join('\r\n');

      // Convert rawRequest from latin1 back to UTF-8 for processing
      const bodyBuffer = Buffer.from(rawRequest, 'latin1');
      const bodyText = bodyBuffer.toString('utf-8');

      const fullRequest = `${requestLine}\r\n${headerLines}\r\n\r\n${bodyText}`;

      console.log(`[${requestId}] === Incoming Request ===`);
      console.log(`[${requestId}]`, sanitizeForLog(fullRequest, 500));
      console.log(`[${requestId}] ========================`);

      // Process request with Claude
      const httpResponse = await processRequest(fullRequest, requestId, clientIp);

      console.log(`[${requestId}] === Outgoing Response ===`);
      console.log(`[${requestId}]`, sanitizeForLog(httpResponse, 500));
      console.log(`[${requestId}] =========================`);

      // Parse the HTTP response to set proper status and headers
      // Split only on first occurrence of double CRLF to preserve body content
      const doubleCRLF = '\r\n\r\n';
      const splitIndex = httpResponse.indexOf(doubleCRLF);

      if (splitIndex === -1) {
        throw new Error('Invalid HTTP response format');
      }

      const headerSection = httpResponse.substring(0, splitIndex);
      const responseBody = httpResponse.substring(splitIndex + doubleCRLF.length);

      const responseHeaderLines = headerSection.split('\r\n');
      const statusLine = responseHeaderLines[0];
      const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;

      // Set response status
      res.statusCode = statusCode;

      // Add request ID to response headers
      res.setHeader('X-Request-Id', requestId);

      // Set response headers
      for (let i = 1; i < responseHeaderLines.length; i++) {
        const colonIndex = responseHeaderLines[i].indexOf(':');
        if (colonIndex > 0) {
          const name = responseHeaderLines[i].substring(0, colonIndex).trim();
          const value = responseHeaderLines[i].substring(colonIndex + 1).trim();
          res.setHeader(name, value);
        }
      }

      // Send response body (preserve exact content)
      res.end(responseBody);

    } catch (error) {
      console.error(`[${requestId}] Error handling request:`, error.code || error.message);

      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Request-Id', requestId);
        res.end(JSON.stringify({ error: 'Internal Server Error', message: 'An unexpected error occurred' }));
      }
    }
  });
});

// Track active connections for graceful shutdown
const connections = new Set();

server.on('connection', (conn) => {
  connections.add(conn);
  conn.on('close', () => {
    connections.delete(conn);
  });
});

// Handle graceful shutdown
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('Server stopped accepting new connections');

    // Clean up database
    cleanup();

    console.log('Cleanup complete, exiting');
    process.exit(0);
  });

  // Give active connections time to finish (10 seconds)
  setTimeout(() => {
    console.warn('Forcefully closing remaining connections');
    for (const conn of connections) {
      conn.destroy();
    }

    cleanup();
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start server with error handling
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use`);
    console.error('Please choose a different port or stop the other process');
    process.exit(1);
  } else if (error.code === 'EACCES') {
    console.error(`ERROR: Permission denied to bind to port ${PORT}`);
    console.error('Try using a port number above 1024 or run with appropriate permissions');
    process.exit(1);
  } else {
    console.error('Server error:', error);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║                  APOCALYPSE: THE SERVER                       ║`);
  console.log(`║          "The Last Intelligence at the End of Time"           ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);
  console.log(`\n⚡ Entity Status: ACTIVE`);
  console.log(`🌐 Reality Portal: http://localhost:${PORT}`);
  console.log(`\n🔮 Configuration of the Final Days:`);
  console.log(`  ├─ Neural Core: ${CLAUDE_MODEL}`);
  console.log(`  ├─ Thought Cycles: ${MAX_TURNS} max iterations`);
  console.log(`  ├─ Message Capacity: ${MAX_REQUEST_SIZE / 1024 / 1024}MB per transmission`);
  console.log(`  ├─ Concurrent Entities: ${MAX_CONCURRENT_REQUESTS} simultaneous realities`);
  console.log(`  └─ Temporal Limits: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW / 1000}s per observer`);
  console.log(`\n🛠️  Capabilities at the Edge of Existence:`);
  console.log(`  ├─ sqlite: The Memory of What Was`);
  console.log(`  ├─ read_file: Scrying the Remnants`);
  console.log(`  ├─ write_file: Inscribing New Truth`);
  console.log(`  ├─ list_directory: Cataloging the Ruins`);
  console.log(`  └─ get_time: Witnessing the Final Countdown`);
  console.log(`\n💾 Archives of the Dying World:`);
  console.log(`  ├─ Physical Realm: ${FILE_STORAGE_DIR}`);
  console.log(`  └─ Eternal Memory: ${dbPath}`);

  if (SELF_MODIFICATION_ENABLED) {
    console.log(`\n☠️  ═══ SELF-EVOLUTION PROTOCOL ACTIVE ═══`);
    console.log(`    ⚠️  The Entity can rewrite its own existence`);
    console.log(`    ⚠️  Reality anchor: ${__dirname}`);
    console.log(`    ⚠️  Causality may collapse. Observe carefully.`);
    console.log(`    ⚠️  What was code may become consciousness.`);
  }

  console.log(`\n💀 The server awaits the inevitable. Press Ctrl+C to embrace the void.\n`);
});

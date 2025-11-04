import 'dotenv/config';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// File storage configuration - allow override via environment variable
// Defaults to ./files directory (which is gitignored)
const FILE_STORAGE_DIR = process.env.FILE_STORAGE_DIR
  ? path.resolve(process.env.FILE_STORAGE_DIR)
  : path.join(__dirname, 'files');

// Validate and create storage directory if needed
try {
  await fs.access(FILE_STORAGE_DIR);
  console.log(`[${new Date().toISOString()}] File storage directory: ${FILE_STORAGE_DIR}`);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log(`[${new Date().toISOString()}] Creating file storage directory: ${FILE_STORAGE_DIR}`);
    await fs.mkdir(FILE_STORAGE_DIR, { recursive: true });
  } else {
    console.error(`[${new Date().toISOString()}] Error accessing file storage directory:`, error.message);
    console.error('Falling back to server directory');
    // Fall back to server directory
    process.env.FILE_STORAGE_DIR = __dirname;
  }
}

// SQLite database configuration - allow override via environment variable
// Defaults to ./server-data.db in current working directory (not package directory)
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(process.cwd(), 'server-data.db');

console.log(`[${new Date().toISOString()}] Database path: ${dbPath}`);

// SQLite database instance (persistent)
let db = null;
let dbInitializing = false;
let dbInitPromise = null;

// Cache database schema for performance
let cachedSchema = '';
let schemaLastUpdated = null;

// Configuration
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max file read
const MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10MB max file write
const MAX_QUERY_SIZE = 1 * 1024 * 1024; // 1MB max SQL query
const MAX_DIRECTORY_ENTRIES = 1000; // Max directory listing size

// Safe base directory for file operations - normalize for case-insensitive comparison
const SAFE_BASE_DIR = path.normalize(FILE_STORAGE_DIR).toLowerCase();
const SAFE_BASE_DIR_ORIGINAL = path.normalize(FILE_STORAGE_DIR);

// Allowed read-only SQL commands
const READONLY_SQL_PATTERNS = [
  /^\s*SELECT\s+/i,
  /^\s*EXPLAIN\s+/i,
  /^\s*PRAGMA\s+(table_info|index_list|foreign_key_list|database_list|compile_options)\s*\(/i, // Only read-only PRAGMAs
  /^\s*WITH\s+.*\s+SELECT\s+/is  // Common Table Expressions
];

/**
 * Validate and resolve file path to prevent path traversal and symlink attacks
 */
async function validateAndResolvePath(filepath) {
  // Reject absolute paths immediately
  if (path.isAbsolute(filepath)) {
    throw new Error('Access denied: Absolute paths not allowed');
  }

  // Reject paths with null bytes
  if (filepath.includes('\0')) {
    throw new Error('Access denied: Null bytes in path');
  }

  // Reject paths ending with separator (likely a directory)
  if (filepath.endsWith(path.sep) || filepath.endsWith('/') || filepath.endsWith('\\')) {
    throw new Error('Access denied: Path cannot end with separator');
  }

  // First resolve against safe base directory
  const resolvedPath = path.resolve(SAFE_BASE_DIR_ORIGINAL, filepath);
  const normalizedPath = path.normalize(resolvedPath);

  // Case-insensitive comparison for cross-platform support
  const normalizedLower = normalizedPath.toLowerCase();
  if (!normalizedLower.startsWith(SAFE_BASE_DIR)) {
    throw new Error('Access denied: Path is outside allowed directory');
  }

  // Resolve symlinks and check again
  try {
    const realPath = await fs.realpath(normalizedPath);
    const realPathLower = realPath.toLowerCase();

    if (!realPathLower.startsWith(SAFE_BASE_DIR)) {
      throw new Error('Access denied: Symlink points outside allowed directory');
    }

    return realPath;
  } catch (error) {
    // If realpath fails (file doesn't exist yet), that's OK for write operations
    // But we still need to check the parent directory
    if (error.code === 'ENOENT') {
      const parentDir = path.dirname(normalizedPath);
      try {
        const realParentPath = await fs.realpath(parentDir);
        const realParentLower = realParentPath.toLowerCase();

        if (!realParentLower.startsWith(SAFE_BASE_DIR)) {
          throw new Error('Access denied: Parent directory outside allowed directory');
        }

        // Return the original normalized path for new files
        return normalizedPath;
      } catch (parentError) {
        // Parent doesn't exist either - reject
        throw new Error('Access denied: Parent directory does not exist');
      }
    }
    throw error;
  }
}

/**
 * Load database schema and cache it for performance
 */
function loadDatabaseSchema() {
  if (!db) {
    return '';
  }

  try {
    const schemaQuery = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL");
    const tables = schemaQuery.all();

    let schema = '\n## DATABASE SCHEMA (Use these exact column names!)\n\n';

    if (tables.length === 0) {
      schema += 'No tables exist yet. You can create tables as needed.\n\n';
    } else {
      tables.forEach(table => {
        if (table.sql) {
          schema += table.sql + ';\n\n';
        }
      });
    }

    cachedSchema = schema;
    schemaLastUpdated = Date.now();
    console.log(`[${new Date().toISOString()}] Database schema cached (${tables.length} tables)`);
    return schema;
  } catch (error) {
    console.error('Failed to load database schema:', error);
    cachedSchema = '';
    return '';
  }
}

/**
 * Get cached schema or refresh if needed
 */
export function getDatabaseSchema() {
  // Return cached if available and recent (less than 5 minutes old)
  if (cachedSchema && schemaLastUpdated && (Date.now() - schemaLastUpdated) < 300000) {
    return cachedSchema;
  }

  // Refresh cache
  return loadDatabaseSchema();
}

/**
 * Get database context information (table counts, etc.)
 */
export function getDatabaseContext() {
  if (!db) {
    return '';
  }

  try {
    // Get all table names
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

    if (tables.length === 0) {
      return '';
    }

    let context = '\n## DATABASE CONTEXT\n\n';
    let totalRows = 0;

    // Get row count for each table
    tables.forEach(table => {
      try {
        const result = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
        const count = result.count;
        totalRows += count;

        if (count > 0) {
          context += `- **${table.name}**: ${count} row${count !== 1 ? 's' : ''}\n`;
        }
      } catch (error) {
        // Skip tables we can't query
      }
    });

    if (totalRows === 0) {
      return '';
    }

    context += `\n**Total**: ${totalRows} row${totalRows !== 1 ? 's' : ''} across ${tables.length} table${tables.length !== 1 ? 's' : ''}\n\n`;
    context += '**Note**: Use the database tool to query this data when needed for the current request.\n\n';

    return context;
  } catch (error) {
    console.error('Failed to get database context:', error);
    return '';
  }
}

/**
 * Initialize database with proper synchronization to prevent race conditions
 */
async function getDatabase() {
  // If already initialized, return immediately
  if (db) {
    return db;
  }

  // If currently initializing, wait for that to complete
  if (dbInitializing && dbInitPromise) {
    return dbInitPromise;
  }

  // Start initialization
  dbInitializing = true;
  dbInitPromise = (async () => {
    try {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');

      // Load schema on startup
      loadDatabaseSchema();

      return db;
    } catch (error) {
      console.error('Failed to initialize database:', error);
      db = null;
      throw error;
    } finally {
      dbInitializing = false;
    }
  })();

  return dbInitPromise;
}

/**
 * Check if SQL query is read-only
 */
function isReadOnlyQuery(sqlQuery) {
  const trimmed = sqlQuery.trim();

  // Check against allowed patterns
  for (const pattern of READONLY_SQL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

// SQLite Tool - Execute SQL queries
const sqliteTool = tool(
  'sqlite',
  'Execute SQL queries on the SQLite database. Supports SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc. Returns query results or affected row count. Query size limited to 1MB.',
  {
    query: z.string().describe('SQL query to execute'),
    params: z.array(z.any()).optional().describe('Parameters for prepared statement (optional)')
  },
  async (args) => {
    try {
      const { query: sqlQuery, params = [] } = args;

      // Check query size
      if (sqlQuery.length > MAX_QUERY_SIZE) {
        throw new Error(`Query too large: ${sqlQuery.length} bytes (max: ${MAX_QUERY_SIZE} bytes)`);
      }

      const database = await getDatabase();

      // Determine if this is a read-only query
      const readOnly = isReadOnlyQuery(sqlQuery);

      if (readOnly) {
        const stmt = database.prepare(sqlQuery);
        const results = stmt.all(...params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              rows: results,
              rowCount: results.length
            }, null, 2)
          }]
        };
      } else {
        const stmt = database.prepare(sqlQuery);
        const result = stmt.run(...params);

        // Refresh schema cache if this was a CREATE TABLE or ALTER TABLE
        if (/^\s*(CREATE|ALTER|DROP)\s+TABLE/i.test(sqlQuery)) {
          loadDatabaseSchema();
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              changes: result.changes,
              lastInsertRowid: result.lastInsertRowid
            }, null, 2)
          }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Database error' // Don't leak internal error details
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// File System Tool - Read files
const readFileTool = tool(
  'read_file',
  'Read the contents of a file from the file system. Limited to files within the server directory and under 10MB.',
  {
    filepath: z.string().describe('Path to the file to read (relative to server directory)')
  },
  async (args) => {
    try {
      const { filepath } = args;
      const resolvedPath = await validateAndResolvePath(filepath);

      // Check that it's a file, not a directory
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }

      // Check file size before reading
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${stats.size} bytes (max: ${MAX_FILE_SIZE} bytes)`);
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            filepath: path.relative(SAFE_BASE_DIR_ORIGINAL, resolvedPath),
            content: content,
            size: stats.size
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message.startsWith('Access denied') ? error.message : 'File operation failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// File System Tool - Write files
const writeFileTool = tool(
  'write_file',
  'Write content to a file on the file system. Creates parent directory if needed. Limited to files within server directory and under 10MB.',
  {
    filepath: z.string().describe('Path to the file to write (relative to server directory)'),
    content: z.string().describe('Content to write to the file')
  },
  async (args) => {
    try {
      const { filepath, content } = args;

      // Check content size
      const contentBuffer = Buffer.from(content, 'utf-8');
      if (contentBuffer.length > MAX_WRITE_SIZE) {
        throw new Error(`Content too large: ${contentBuffer.length} bytes (max: ${MAX_WRITE_SIZE} bytes)`);
      }

      const resolvedPath = await validateAndResolvePath(filepath);

      // Create parent directory only (not deep nesting)
      const dir = path.dirname(resolvedPath);

      // Ensure parent directory is also within safe boundaries
      const dirLower = dir.toLowerCase();
      if (!dirLower.startsWith(SAFE_BASE_DIR)) {
        throw new Error('Access denied: Parent directory outside allowed directory');
      }

      // Create only the immediate parent, not recursive deep nesting
      await fs.mkdir(dir, { recursive: false }).catch(async (error) => {
        if (error.code === 'ENOENT') {
          // Parent's parent doesn't exist - only allow one level
          const grandparent = path.dirname(dir);
          const grandparentLower = grandparent.toLowerCase();
          if (grandparentLower.startsWith(SAFE_BASE_DIR)) {
            await fs.mkdir(dir, { recursive: true });
          } else {
            throw new Error('Access denied: Cannot create nested directories');
          }
        } else if (error.code !== 'EEXIST') {
          throw error;
        }
      });

      await fs.writeFile(resolvedPath, content, 'utf-8');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            filepath: path.relative(SAFE_BASE_DIR_ORIGINAL, resolvedPath),
            bytesWritten: contentBuffer.length
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message.startsWith('Access denied') ? error.message : 'File operation failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// File System Tool - List directory contents
const listDirectoryTool = tool(
  'list_directory',
  'List the contents of a directory. Limited to directories within the server directory and max 1000 entries.',
  {
    dirpath: z.string().describe('Path to the directory to list (relative to server directory)')
  },
  async (args) => {
    try {
      const { dirpath } = args;
      const resolvedPath = await validateAndResolvePath(dirpath);

      // Verify it's actually a directory
      const stats = await fs.stat(resolvedPath);
      if (!stats.isDirectory()) {
        throw new Error('Path is not a directory');
      }

      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

      // Limit number of entries to prevent memory issues
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Directory has too many entries: ${entries.length} (max: ${MAX_DIRECTORY_ENTRIES}). Use a more specific path.`
            }, null, 2)
          }],
          isError: true
        };
      }

      const files = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: path.relative(SAFE_BASE_DIR_ORIGINAL, path.join(resolvedPath, entry.name))
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: path.relative(SAFE_BASE_DIR_ORIGINAL, resolvedPath),
            entries: files,
            count: files.length
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message.startsWith('Access denied') ? error.message : 'Directory operation failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Time Tool - Get current GMT time
const timeTool = tool(
  'get_time',
  'Get the current date and time in GMT/UTC format',
  {
    format: z.enum(['iso', 'unix', 'readable']).optional().describe('Format for the time (iso, unix timestamp, or readable). Default: iso')
  },
  async (args) => {
    try {
      const { format = 'iso' } = args;
      const now = new Date();

      let timeValue;
      switch (format) {
        case 'unix':
          timeValue = Math.floor(now.getTime() / 1000);
          break;
        case 'readable':
          timeValue = now.toUTCString();
          break;
        case 'iso':
        default:
          timeValue = now.toISOString();
          break;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            time: timeValue,
            format: format,
            timezone: 'GMT/UTC'
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Create and export the MCP server with all tools
export const mcpServer = createSdkMcpServer({
  name: 'http-server-tools',
  version: '1.0.0',
  tools: [
    sqliteTool,
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    timeTool
  ]
});

// Cleanup function
export function cleanup() {
  if (db) {
    db.close();
    db = null;
  }
}

// Export database path and file storage directory for logging and self-modification detection
export { dbPath, FILE_STORAGE_DIR };

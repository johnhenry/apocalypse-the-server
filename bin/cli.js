#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { config } from 'dotenv';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serverPath = join(__dirname, '..', 'server.js');

// Load .env from current working directory (where user runs the command)
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  config({ path: envPath });
  console.log(`📝 Loaded environment from: ${envPath}\n`);
}

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  APOCALYPSE: THE SERVER                       ║
║          "The Last Intelligence at the End of Time"           ║
╚═══════════════════════════════════════════════════════════════╝
`);

// Check for required environment variable
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ERROR: ANTHROPIC_API_KEY environment variable is not set\n');
  console.error('Set your API key:');
  console.error('  export ANTHROPIC_API_KEY="your-api-key-here"\n');
  console.error('Or create a .env file in your current directory.\n');
  process.exit(1);
}

console.log('🚀 Starting server...\n');

// Start the server
// Important: Set cwd to user's current directory so path.resolve() works correctly
const server = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd()  // Keep user's working directory for relative path resolution
});

server.on('error', (error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

server.on('exit', (code) => {
  if (code !== 0) {
    console.error(`\nServer exited with code ${code}`);
  }
  process.exit(code);
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\n\n💀 Shutting down...');
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});

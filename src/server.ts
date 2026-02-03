/**
 * Server Entry Point
 *
 * Starts the API server with all services.
 */

import 'dotenv/config';
import { startServer } from './api/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

console.log('Starting Open Multi-Agents Server...');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

startServer(PORT).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

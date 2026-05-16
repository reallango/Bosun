import { rqlite } from './rqlite-client';
import { runMigrations } from './migrations';

export async function initializeDatabase(): Promise<void> {
  console.log('Initializing database...');
  
  // Wait for rqlite to be ready
  let attempts = 0;
  while (!(await rqlite.isReady()) && attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
    console.log('Waiting for rqlite...');
  }

  if (!(await rqlite.isReady())) {
    throw new Error('rqlite failed to start');
  }

  console.log('rqlite is ready');

  // Run migrations
  await runMigrations();

  console.log('Database initialized');
}

export default initializeDatabase;
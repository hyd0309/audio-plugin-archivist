// Intentionally empty by default.
// Add Drizzle tables here when the site actually needs a database.
// See examples/d1/db/schema.ts for an opt-in example.
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const accounts = sqliteTable('accounts', {
  owner: text('owner').primaryKey(),
  vault: text('vault').notNull(),
  updated: integer('updated').notNull(),
});
export const oauth = sqliteTable('oauth', {
  state: text('state').primaryKey(),
  owner: text('owner').notNull(),
  binding: text('binding').notNull(),
  expires: integer('expires').notNull(),
});
export const guards = sqliteTable('guards', {
  owner: text('owner').primaryKey(),
  lease: text('lease').notNull().default(''),
  until: integer('until').notNull().default(0),
  minute: integer('minute').notNull().default(0),
  count: integer('count').notNull().default(0),
  day: integer('day').notNull().default(0),
  calls: integer('calls').notNull().default(0),
});

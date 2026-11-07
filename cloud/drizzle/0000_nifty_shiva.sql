CREATE TABLE `accounts` (
	`owner` text PRIMARY KEY NOT NULL,
	`vault` text NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guards` (
	`owner` text PRIMARY KEY NOT NULL,
	`lease` text DEFAULT '' NOT NULL,
	`until` integer DEFAULT 0 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`day` integer DEFAULT 0 NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth` (
	`state` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`binding` text NOT NULL,
	`expires` integer NOT NULL
);

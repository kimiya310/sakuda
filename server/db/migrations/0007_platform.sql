CREATE TABLE `platform_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`status` text NOT NULL,
	`snapshot` text NOT NULL,
	`scope` text NOT NULL,
	`authorization` text NOT NULL,
	`result` text NOT NULL,
	`review` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`error` text,
	FOREIGN KEY (`group_id`) REFERENCES `platform_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `platform_runs_group_created_idx` ON `platform_runs` (`group_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_runs_status_idx` ON `platform_runs` (`status`);

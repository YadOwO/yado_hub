CREATE TABLE "yado_hub"."agent_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_commands_status_check" CHECK ("yado_hub"."agent_commands"."status" in ('pending', 'sent', 'succeeded', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "yado_hub"."agent_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "yado_hub"."agent_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" text NOT NULL,
	"local_id" bigint NOT NULL,
	"instance_id" text,
	"run_id" text,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yado_hub"."agent_machines" (
	"id" text PRIMARY KEY NOT NULL,
	"agentd_version" text NOT NULL,
	"state" jsonb NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yado_hub"."agent_runs" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "yado_hub"."agent_runs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" text NOT NULL,
	"run_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"status" text NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_commands_machine_status_idx" ON "yado_hub"."agent_commands" USING btree ("machine_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_events_machine_local_uniq" ON "yado_hub"."agent_events" USING btree ("machine_id","local_id");--> statement-breakpoint
CREATE INDEX "agent_events_run_idx" ON "yado_hub"."agent_events" USING btree ("machine_id","run_id");--> statement-breakpoint
CREATE INDEX "agent_events_at_idx" ON "yado_hub"."agent_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_machine_run_uniq" ON "yado_hub"."agent_runs" USING btree ("machine_id","run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_queued_idx" ON "yado_hub"."agent_runs" USING btree ("queued_at");
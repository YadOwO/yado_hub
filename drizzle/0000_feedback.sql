-- 生产环境的 yado_hub schema 由 deploy/postgres-init.sql 预先创建，迁移记录表也在其中，故用 IF NOT EXISTS
CREATE SCHEMA IF NOT EXISTS "yado_hub";
--> statement-breakpoint
CREATE TABLE "yado_hub"."feedback_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product" text NOT NULL,
	"user_id" text NOT NULL,
	"user_read_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yado_hub"."feedback_messages" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "yado_hub"."feedback_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"content" text NOT NULL,
	"client_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_messages_sender_check" CHECK ("yado_hub"."feedback_messages"."sender" in ('user', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "yado_hub"."feedback_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_message_seq" bigint NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_tickets_status_check" CHECK ("yado_hub"."feedback_tickets"."status" in ('pending', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "yado_hub"."feedback_messages" ADD CONSTRAINT "feedback_messages_conversation_id_feedback_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "yado_hub"."feedback_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yado_hub"."feedback_messages" ADD CONSTRAINT "feedback_messages_ticket_id_feedback_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "yado_hub"."feedback_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yado_hub"."feedback_tickets" ADD CONSTRAINT "feedback_tickets_conversation_id_feedback_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "yado_hub"."feedback_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_conversations_product_user_uniq" ON "yado_hub"."feedback_conversations" USING btree ("product","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_messages_id_uniq" ON "yado_hub"."feedback_messages" USING btree ("id");--> statement-breakpoint
CREATE INDEX "feedback_messages_conversation_seq_idx" ON "yado_hub"."feedback_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_tickets_one_pending_uniq" ON "yado_hub"."feedback_tickets" USING btree ("conversation_id") WHERE "yado_hub"."feedback_tickets"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "feedback_tickets_conversation_idx" ON "yado_hub"."feedback_tickets" USING btree ("conversation_id","last_message_seq");--> statement-breakpoint
CREATE INDEX "feedback_tickets_status_last_idx" ON "yado_hub"."feedback_tickets" USING btree ("status","last_message_seq");
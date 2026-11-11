CREATE TABLE "yado_hub"."feedback_anonymized_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_message_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feedback_anonymized_tickets_status_check" CHECK ("yado_hub"."feedback_anonymized_tickets"."status" in ('pending', 'resolved'))
);

CREATE TABLE "yado_hub"."deleted_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);

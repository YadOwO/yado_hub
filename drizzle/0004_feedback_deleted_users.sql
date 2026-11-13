CREATE TABLE "yado_hub"."feedback_deleted_users" (
	"user_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

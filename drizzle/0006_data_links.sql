CREATE TABLE "yado_hub"."data_links" (
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"scope" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "data_links_user_id_source_target_scope_pk" PRIMARY KEY("user_id","source","target","scope")
);

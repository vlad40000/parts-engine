CREATE TABLE "model_diagrams" (
	"brand_key" text NOT NULL,
	"exact_model" text NOT NULL,
	"source_sha256" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_diagrams_brand_key_exact_model_pk" PRIMARY KEY("brand_key","exact_model")
);
